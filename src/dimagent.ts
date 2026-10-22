import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedResponse} from './completion.js';
import type {SessionStore} from './store.js';

export interface DimagentReply {response: string; model?: string; provider?: string}
export type DimagentRead = (sessionId: string, runId: string, signal: AbortSignal) => Promise<DimagentReply | undefined>;
export function dimagentCommand(): string {
  if (process.env.ADP_DIMAGENT_COMMAND) return process.env.ADP_DIMAGENT_COMMAND;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bundled = join(process.env.LOCALAPPDATA, 'Programs', 'DimAgent', 'resources', 'runtime', 'cli', 'dim.exe');
    if (existsSync(bundled)) return bundled;
  }
  return 'dim';
}

/** Auxiliary commands share the configured host home, but never run its hooks. */
export async function runDimagent(args: string[], signal: AbortSignal, input?: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'adp-dimagent-'));
  try {
    return await new Promise<string>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(dimagentCommand(), args, {cwd: directory, windowsHide: true, signal, killSignal: 'SIGKILL',
        env: {...process.env, ADP_SUMMARY_WORKER: '1', DIM_DISABLE_HOOKS: '1', DIMCODE_DISABLE_AUTOUPDATE: '1'},
        stdio: ['pipe', 'pipe', 'ignore']});
      let size = 0; let output = ''; let failure: Error | undefined;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) { failure = new Error('DimAgent output limit exceeded'); child.kill('SIGKILL'); }
        else output += chunk;
      });
      child.on('error', () => { failure = new Error('DimAgent command unavailable'); });
      child.on('close', code => failure ? reject(failure) : code === 0 ? resolve(output) : reject(new Error('DimAgent auxiliary command failed')));
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  } finally { await rm(directory, {recursive: true, force: true}); }
}

/** Read only the final assistant text of the exact run, never a previous reply. */
export function extractDimagentReply(value: unknown, sessionId: string, runId: string): DimagentReply | undefined {
  const data = value as {version?: string; metadata?: {id?: string; model?: {modelId?: unknown; provider?: unknown}}; messages?: Message[]} | null;
  interface Message {sessionId?: string; role?: string; metadata?: {runId?: string; kind?: string}; parts?: {type?: string; text?: string}[]}
  if (data?.version !== '1' || data.metadata?.id !== sessionId || !Array.isArray(data.messages) || data.messages.length > 10_000) return;
  const messages = data.messages;
  const last = messages.at(-1);
  if (last?.sessionId !== sessionId || last.metadata?.runId !== runId || last.role !== 'assistant') return;
  const run = messages.filter(m => m.sessionId === sessionId && m.metadata?.runId === runId);
  if (!run.some(m => m.role === 'user') || run.some(m => m.metadata?.kind === 'run_terminal')) return;
  if (last.metadata?.kind || !Array.isArray(last.parts) || last.parts.some(p => p.type === 'tool-call' || p.type === 'tool_call')) return;
  const response = boundedResponse(last.parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n'));
  if (!response) return;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
  return {response, model: id(data.metadata.model?.modelId), provider: id(data.metadata.model?.provider)};
}
export const readDimagentReply: DimagentRead = async (sessionId, runId, signal) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Stop runs before all terminal bookkeeping has committed.
    await delay(attempt ? 500 : 250, undefined, {signal});
    const value = JSON.parse(await runDimagent(['session', 'export', sessionId], signal));
    const reply = extractDimagentReply(value, sessionId, runId);
    if (reply) return reply;
  }
};

interface Target {key: string; sessionId: string; runId: string; startedAt: number; updatedAt: number; revision: number}
/** One bounded background reader; source exports never enter status or logs. */
export class DimagentCompletion {
  private pending = new Map<string, Target>();
  private active?: {target: Target; controller: AbortController};
  private running?: Promise<void>;
  private stopped = false;
  completed = 0; failed = 0; discarded = 0; lastError: string | null = null;
  constructor(private store: SessionStore, private enabled: () => boolean,
    private submit: (key: string, reply: DimagentReply) => void, private read: DimagentRead = readDimagentReply) {}
  get status() { return {active: !!this.active, queued: this.pending.size, completed: this.completed, failed: this.failed, discarded: this.discarded, lastError: this.lastError}; }
  enqueue(key: string, runId: unknown): void {
    const s = this.store.sessions.get(key);
    if (this.stopped || !this.enabled() || !s || s.agent !== 'dimagent' || s.state !== 'idle' ||
        typeof runId !== 'string' || !runId.length || runId.length > 256) return;
    if (this.pending.size >= 32 && !this.pending.has(key)) { this.pending.delete(this.pending.keys().next().value!); this.discarded++; }
    this.pending.set(key, {key, sessionId: s.sessionId, runId, startedAt: s.startedAt, updatedAt: s.updatedAt, revision: s.generationRevision});
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private current(t: Target): boolean {
    const s = this.store.sessions.get(t.key);
    return !this.stopped && this.enabled() && !!s && s.state === 'idle' && s.startedAt === t.startedAt &&
      s.updatedAt === t.updatedAt && s.generationRevision === t.revision;
  }
  reconcile(): void {
    for (const [key, t] of this.pending) if (!this.current(t)) { this.pending.delete(key); this.discarded++; }
    if (this.active && !this.current(this.active.target)) this.active.controller.abort();
  }
  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.size) {
      const [key, target] = this.pending.entries().next().value!; this.pending.delete(key);
      if (!this.current(target)) { this.discarded++; continue; }
      const controller = new AbortController(); this.active = {target, controller};
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const reply = await this.read(target.sessionId, target.runId, controller.signal);
        if (!reply || controller.signal.aborted || !this.current(target)) { this.discarded++; continue; }
        this.submit(key, reply); this.completed++; this.lastError = null;
      } catch {
        if (this.current(target)) { this.failed++; this.lastError = 'Could not read DimAgent completion; check ADP_DIMAGENT_COMMAND and DIMCODE_HOME'; }
        else this.discarded++;
      } finally { clearTimeout(timer); this.active = undefined; }
    }
  }
  async close(): Promise<void> { this.stopped = true; this.pending.clear(); this.active?.controller.abort(); await this.running; }
}
