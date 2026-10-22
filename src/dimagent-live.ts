import {boundedResponse} from './completion.js';
import {runDimagent} from './dimagent.js';
import {parseSummary, type Summary} from './summary.js';
import type {Generate, ModelContext} from './generation.js';
import type {Settings} from './settings.js';
import type {Session, SessionStore} from './store.js';

const phases = {planning: '分析实现方案', reading: '阅读项目文件', editing: '修改项目文件',
  command: '运行命令', tool: '执行工具', waiting: '等待工具授权', compacting: '整理会话上下文', delegating: '执行子任务'} as const;
type Phase = keyof typeof phases;
export type DimagentActivity = {kind: 'start'; goal: string} | {kind: 'progress'; phase: Phase} | {kind: 'finish'};

/** Bound source context and remove common secret/path forms; semantic redaction still requires the model. */
export function taskGoal(value: unknown): string {
  return Array.from(boundedResponse(value)
    .replace(/\bBearer\s+\S+/gi, '[credential]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[credential]')
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[credential]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .replace(/[A-Za-z]:[\\/][^\s"<>]+|(?:\/~|~\/|\/(?:Users|home|tmp|var)\/)[^\s"<>]+/g, '[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 2000).join('');
}

/** Tool names become a fixed phase; tool arguments/results never cross this boundary. */
export function dimagentActivity(payload: Record<string, unknown>): DimagentActivity | undefined {
  const name = payload.hook_event_name;
  if (name === 'UserPromptSubmit') return {kind: 'start', goal: taskGoal(payload.prompt)};
  if (name === 'Stop') return {kind: 'finish'};
  if (name === 'PermissionRequest') return {kind: 'progress', phase: 'waiting'};
  if (name === 'PreCompact' || name === 'PostCompact') return {kind: 'progress', phase: 'compacting'};
  if (name !== 'PreToolUse' && name !== 'PostToolUse') return;
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name.toLowerCase() : '';
  const phase: Phase = ['read', 'glob', 'grep', 'ls', 'list_directory'].includes(tool) ? 'reading'
    : ['write', 'edit', 'replace_text', 'replace-text', 'apply_patch'].includes(tool) ? 'editing'
    : ['exec', 'bash', 'shell'].includes(tool) ? 'command' : tool === 'agent' ? 'delegating' : 'tool';
  return {kind: 'progress', phase};
}

export type DimagentModelRead = (sessionId: string, signal: AbortSignal) => Promise<ModelContext>;
export function extractDimagentModel(data: unknown, sessionId: string): ModelContext {
  if (!Array.isArray(data) || data.length > 10_000) throw new Error('DimAgent session list unavailable');
  const session = data.find(s => s?.id === sessionId);
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
  const model = id(session?.model?.modelId); const provider = id(session?.model?.provider);
  if (!model) throw new Error('DimAgent model route unavailable');
  return {model, provider};
}
export const readDimagentModel: DimagentModelRead = async (sessionId, signal) => {
  // Export/show acquire the session lease and fail while Desktop/CLI is working.
  // List reads persisted metadata without taking ownership of the active session.
  return extractDimagentModel(JSON.parse(await runDimagent(['session', 'list', '--all', '--json'], signal)), sessionId);
};

interface Entry {epoch: number; startedAt: number; active: boolean; manual: boolean; phase: Phase; desired: Phase; phaseAt: number}
interface Job {key: string; entry: Entry; goal: string; policy: string}
/** Task-scoped titles survive tool events; templates update without model calls. */
export class DimagentLive {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Job>();
  private active?: {job: Job; controller: AbortController};
  private running?: Promise<void>;
  private stopped = false;
  private epoch = 0;
  completed = 0; failed = 0; discarded = 0; lastError: string | null = null;
  constructor(private store: SessionStore, private settings: () => Settings, private generate: Generate,
    private changed: () => void, private readModel: DimagentModelRead = readDimagentModel,
    private now = Date.now, private interval = 5000) {}
  get status() { return {active: !!this.active, queued: this.pending.size, completed: this.completed, failed: this.failed, discarded: this.discarded, lastError: this.lastError}; }
  private enabled(): boolean { const s = this.settings(); return !this.stopped && s.enabled && s.liveSummaries; }
  private policy(): string {
    const s = this.settings(); return JSON.stringify([s.enabled, s.liveSummaries, s.service, s.model, s.provider, s.baseUrl, s.apiKeyEnv, s.customPrompt, s.maxLength]);
  }
  handle(key: string, value: unknown): void {
    const hint = value as Partial<DimagentActivity> | undefined;
    const s = this.store.sessions.get(key);
    if (!s || s.agent !== 'dimagent' || !hint) return;
    if (hint.kind === 'start' && s.state === 'working') this.start(key, 'goal' in hint ? hint.goal : undefined);
    if (hint.kind === 'finish' && s.state === 'idle') this.finish(key);
    if (hint.kind === 'progress' && this.enabled()) {
      const entry = this.entries.get(key);
      const phase = 'phase' in hint ? hint.phase : undefined;
      if (entry?.active && !entry.manual && phase && Object.hasOwn(phases, phase)) {
        entry.desired = phase;
        if (phase === 'waiting' || entry.phase === 'waiting') { entry.phase = phase; entry.phaseAt = this.now(); }
      }
    }
  }
  private start(key: string, value: unknown): void {
    this.cancel(key);
    const s = this.store.sessions.get(key)!;
    const entry: Entry = {epoch: ++this.epoch, startedAt: s.startedAt, active: true, manual: false,
      phase: 'planning', desired: 'planning', phaseAt: this.now()};
    this.entries.set(key, entry);
    if (!this.enabled()) return;
    s.summary = {topic: '正在分析任务', subtitle: ''};
    const goal = taskGoal(value);
    if (!goal) return;
    if (this.pending.size >= 32 && !this.pending.has(key)) { this.pending.delete(this.pending.keys().next().value!); this.discarded++; }
    this.pending.set(key, {key, entry, goal, policy: this.policy()});
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
  }
  finish(key: string): void { const entry = this.entries.get(key); if (entry) entry.active = false; this.cancel(key); }
  manual(key: string): void {
    let entry = this.entries.get(key);
    const s = this.store.sessions.get(key);
    if (s?.agent !== 'dimagent') return;
    if (!entry && s) { entry = {epoch: ++this.epoch, startedAt: s.startedAt, active: false, manual: true, phase: 'planning', desired: 'planning', phaseAt: this.now()}; this.entries.set(key, entry); }
    if (entry) entry.manual = true;
    this.cancel(key);
  }
  allowsCompletion(key: string): boolean { return !this.entries.get(key)?.manual; }
  private cancel(key: string): void { this.pending.delete(key); if (this.active?.job.key === key) this.active.controller.abort(); }
  private current(job: Job): boolean {
    const s = this.store.sessions.get(job.key); const entry = this.entries.get(job.key);
    return this.enabled() && this.policy() === job.policy && entry === job.entry && entry.active && !entry.manual &&
      !!s && s.startedAt === entry.startedAt && (s.state === 'working' || s.state === 'waiting');
  }
  reconcile(): void {
    for (const [key, entry] of this.entries) if (this.store.sessions.get(key)?.startedAt !== entry.startedAt) { this.cancel(key); this.entries.delete(key); }
    for (const [key, job] of this.pending) if (!this.current(job)) { this.pending.delete(key); this.discarded++; }
    if (this.active && !this.current(this.active.job)) this.active.controller.abort();
  }
  display(s: Session | undefined): Session | undefined {
    if (!s) return;
    const entry = this.entries.get(`dimagent:${s.sessionId}`);
    if (s.agent !== 'dimagent' || !entry?.active || entry.manual || !this.enabled() || !['working', 'waiting'].includes(s.state)) return s;
    if (entry.phase !== entry.desired && this.now() - entry.phaseAt >= this.interval) { entry.phase = entry.desired; entry.phaseAt = this.now(); }
    return {...s, summary: {topic: s.summary?.topic ?? '正在分析任务', subtitle: phases[entry.phase]}};
  }
  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.size) {
      const [key, job] = this.pending.entries().next().value!; this.pending.delete(key);
      if (!this.current(job)) { this.discarded++; continue; }
      const controller = new AbortController(); this.active = {job, controller};
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const settings = this.settings();
        const context = settings.model && (settings.service === 'openai-compatible' || settings.provider) ? {} : await this.readModel(this.store.sessions.get(key)!.sessionId, controller.signal);
        if (controller.signal.aborted || !this.current(job)) { this.discarded++; continue; }
        const s = this.store.sessions.get(key)!;
        s.model = context.model ?? s.model; s.provider = context.provider ?? s.provider;
        const result: Summary = parseSummary(await this.generate('dimagent', job.goal, controller.signal,
          {model: s.model, provider: s.provider, purpose: 'task'}));
        if (controller.signal.aborted || !this.current(job)) { this.discarded++; continue; }
        this.store.sessions.get(key)!.summary = result;
        this.completed++; this.lastError = null; this.changed();
      } catch {
        if (this.current(job)) { this.failed++; this.lastError = 'Task title generation failed; check DimAgent model service and authentication'; }
        else this.discarded++;
      } finally { clearTimeout(timer); this.active = undefined; }
    }
  }
  async close(): Promise<void> { this.stopped = true; this.pending.clear(); this.active?.controller.abort(); await this.running; this.entries.clear(); }
}
