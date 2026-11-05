import {createHash} from 'node:crypto';
import {Reporter, request} from '../client.js';
import {boundedResponse} from '../completion.js';
import {generateSummary} from '../generation.js';
import {buildPresencePrompt} from '../prompts.js';
import {loadSettings, resolveSettings, type Settings} from '../settings.js';
import {parseSummary} from '../summary.js';
import type {PresenceEvent, State} from '../protocol.js';

// Structural subset of Dim's public plugin contract, checked against
// arcships/dim 43f2c84. No rutis or Dim runtime dependency is bundled into ADP.
interface Context {
  get<T>(name: string): T;
  on(name: string, listener: (record: Broadcast) => void): unknown;
  // Plain plugin objects use the Cordis-compatible Context: acquire now,
  // return cleanup. This differs from definePlugin's native ctx.effect.
  effect(acquire: () => () => void | Promise<void>): unknown;
}
interface Plugin {name: string; inject: string[]; apply(ctx: Context): Promise<void>}
interface Lifecycle {activated(): Promise<boolean>; closing(): Promise<unknown>}
interface Model {providerId: string; modelId: string}
interface AuxiliaryModel {
  complete(call: {model: Model; request: {system: string; messages: {role: 'user'; content: string}[]; maxOutputTokens: number}},
    cancelled: () => Promise<void>): Promise<{text: string; stopReason: string}>;
}
interface Event {type: string; name: string; data: Record<string, unknown>}
interface Broadcast {kind: string; branchId?: string; event?: Event}
interface Target {key: string; updatedAt: number; startedAt: number; state: State; summary?: unknown}
interface Entry {
  reporter: Reporter; turn?: string; response: string; request?: string; toolContent: boolean; finalized: boolean;
  approvals: Set<string>; state: State; epoch: number; closed: boolean;
}
interface Job {entry: Entry; epoch: number; event: PresenceEvent}

/** Stable, bounded and distinct from the legacy TypeScript CLI's session ids. */
export function dimSessionId(session: string, branch: string): string {
  return `rust:${createHash('sha256').update(JSON.stringify([session, branch])).digest('hex')}`;
}
function settings(): Settings { return resolveSettings(loadSettings(), 'dimagent'); }
function policy(value: Settings): string {
  return JSON.stringify([value.enabled, value.service, value.model, value.provider, value.baseUrl,
    value.apiKeyEnv, value.customPrompt, value.maxLength]);
}

/** One worker per loaded plugin; latest completion per branch, at most 32 queued. */
class Summaries {
  private pending = new Map<Entry, Job>();
  private active?: {job: Job; controller: AbortController};
  private running?: Promise<void>;
  private closed = false;
  constructor(private auxiliary: AuxiliaryModel) {}
  cancel(entry: Entry): void {
    entry.epoch++; this.pending.delete(entry);
    if (this.active?.job.entry === entry) this.active.controller.abort();
  }
  submit(entry: Entry, event: PresenceEvent): void {
    if (this.closed || entry.closed || !event.response) return;
    if (this.pending.size >= 32 && !this.pending.has(entry)) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(entry, {entry, epoch: entry.epoch, event});
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
  }
  private current(job: Job): boolean {
    return !this.closed && !job.entry.closed && job.entry.epoch === job.epoch && job.entry.state === 'idle';
  }
  private async target(key: string): Promise<Target | undefined> {
    const status = await request({type: 'status'}) as {sessions: Target[]};
    return status.sessions.find(session => session.key === key);
  }
  private async drain(): Promise<void> {
    while (!this.closed && this.pending.size) {
      const [entry, job] = this.pending.entries().next().value!; this.pending.delete(entry);
      const controller = new AbortController(); this.active = {job, controller};
      const timer = setTimeout(() => controller.abort(), 60_000); timer.unref();
      try {
        const config = settings();
        if (!config.enabled || !this.current(job)) continue;
        const key = `dimagent:${job.event.sessionId}`;
        const target = await this.target(key);
        if (!target || target.updatedAt !== job.event.updatedAt || target.state !== 'idle' || !this.current(job)) continue;
        let summary;
        if (config.service === 'openai-compatible') {
          summary = await generateSummary(config, 'dimagent', job.event.response!, controller.signal, job.event);
        } else {
          const modelId = config.model || job.event.model;
          const providerId = config.provider || job.event.provider;
          if (!modelId || !providerId) continue;
          const input = buildPresencePrompt({agent: 'dimagent', response: job.event.response!}, config);
          const cancelled = new Promise<void>(resolve => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener('abort', () => resolve(), {once: true});
          });
          const reply = await this.auxiliary.complete({model: {modelId, providerId}, request: {
            system: input.systemPrompt + '\nReturn only JSON matching this schema:\n' + JSON.stringify(input.schema),
            messages: [{role: 'user', content: input.prompt}], maxOutputTokens: 2048,
          }}, () => cancelled);
          if (reply.stopReason !== 'end_turn' || reply.text.length > 16_384) continue;
          summary = parseSummary(JSON.parse(reply.text));
        }
        controller.signal.throwIfAborted();
        if (!this.current(job) || policy(settings()) !== policy(config) ||
            Array.from(summary.topic).length > config.maxLength || Array.from(summary.subtitle).length > config.maxLength) continue;
        // The generic summary API guards session lifetime and event freshness.
        // Also preserve a manual edit made while the auxiliary call was running.
        const latest = await this.target(key);
        if (!latest || latest.updatedAt !== target.updatedAt || latest.startedAt !== target.startedAt ||
            latest.state !== 'idle' || JSON.stringify(latest.summary) !== JSON.stringify(target.summary) || !this.current(job)) continue;
        await request({type: 'summary', key, summary,
          expectedUpdatedAt: target.updatedAt, expectedStartedAt: target.startedAt});
      } catch { /* Presence failures never fail a Dim listener or expose source/model output. */ }
      finally { clearTimeout(timer); this.active = undefined; }
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.pending.clear(); this.active?.controller.abort(); await this.running;
  }
}

function observer(summaries: Summaries): Plugin {
  return {
    name: 'AgentDiscordPresenceSession', inject: ['sessionIdentity', 'sessionConfig', 'sessionLifecycle'],
    async apply(ctx) {
      if (process.env.ADP_SUMMARY_WORKER === '1') return;
      const entries = new Map<string, Entry>();
      let closed = false; let active = false;
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => {
        closed = true;
        await Promise.all([...entries.values()].map(async entry => {
          entry.closed = true; summaries.cancel(entry); await entry.reporter.close();
        }));
        entries.clear();
      })();
      ctx.effect(() => close);
      const {sessionId} = await ctx.get<{get(): Promise<{sessionId: string}>}>('sessionIdentity').get();
      const config = await ctx.get<{get(): Promise<{model: Model}>}>('sessionConfig').get();
      const lifecycle = ctx.get<Lifecycle>('sessionLifecycle');
      void lifecycle.closing().then(close).catch(close);
      function get(branch: string): Entry {
        let entry = entries.get(branch);
        if (!entry) {
          const reporter = new Reporter('dimagent', dimSessionId(sessionId, branch), async event => {
            try {
              // No response/run-id/activity side channel: the daemon's legacy Dim CLI worker is never used.
              await request({type: 'event', event: {...event, response: undefined}});
              if (event.response && entry && !event.heartbeat) summaries.submit(entry, event);
            } catch { /* The daemon may be offline. Reporter heartbeats reconnect. */ }
          });
          reporter.model = config.model.modelId; reporter.provider = config.model.providerId;
          entry = {reporter, response: '', toolContent: false, finalized: false, approvals: new Set(), state: 'idle', epoch: 0, closed: false};
          entries.set(branch, entry);
        }
        return entry;
      }
      function set(entry: Entry, state: State, response?: string): void {
        entry.state = state;
        if (active) entry.reporter.set(state, response);
      }
      ctx.on(`session/${sessionId}`, record => {
        if (closed || record.kind !== 'event' || !record.event || !record.branchId) return;
        const {type, name, data} = record.event;
        const kind = `${type}/${name}`;
        if (!['branch/start', 'branch/resume', 'branch/end', 'context/configured', 'turn/start', 'turn/end',
          'step/model-start', 'step/text', 'step/model-content', 'step/model-output-end', 'step/tool-use-start', 'step/tool-use',
          'approval/request', 'approval/respond', 'approval/cancelled', 'stop/interrupt'].includes(kind)) return;
        const entry = get(record.branchId);
        if (entry.closed) return;
        if (kind === 'context/configured') {
          const route = data.settings as Partial<Model> | undefined;
          if (typeof route?.modelId === 'string') entry.reporter.model = route.modelId;
          if (typeof route?.providerId === 'string') entry.reporter.provider = route.providerId;
        } else if (kind === 'turn/start') {
          summaries.cancel(entry); entry.turn = typeof data.turn_id === 'string' ? data.turn_id : undefined;
          entry.response = ''; entry.request = undefined; entry.toolContent = false; entry.finalized = false; entry.approvals.clear();
          set(entry, 'working');
        } else if (kind === 'step/model-start' && data.turn_id === entry.turn) {
          entry.response = ''; entry.toolContent = false; entry.finalized = false;
          entry.request = typeof data.request_id === 'string' ? data.request_id : undefined;
        } else if (kind.startsWith('step/') && entry.turn && entry.request && data.turn_id === entry.turn && data.request_id === entry.request) {
          if (kind === 'step/text' && typeof data.delta === 'string') {
            // Some providers omit the optional complete-content snapshot.
            // Preserve whitespace between deltas and bound the retained prefix.
            entry.response = Array.from(entry.response + data.delta.slice(0, 8000)).slice(0, 4000).join('');
          }
          if (kind === 'step/tool-use-start' || kind === 'step/tool-use') entry.toolContent = true;
          if (kind === 'step/model-content') {
            const parts = Array.isArray(data.content) ? data.content as {type?: string; text?: unknown}[] : [];
            entry.toolContent ||= parts.some(part => part.type === 'tool_use');
            entry.response = boundedResponse(parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'));
          }
          if (kind === 'step/model-output-end') entry.finalized = data.status === 'completed' && data.finish_reason === 'end_turn';
        } else if (kind === 'approval/request') {
          summaries.cancel(entry);
          if (typeof data.approval_id === 'string') entry.approvals.add(data.approval_id);
          set(entry, 'waiting');
        } else if (kind === 'approval/respond' || kind === 'approval/cancelled') {
          if (typeof data.approval_id === 'string') entry.approvals.delete(data.approval_id);
          set(entry, entry.approvals.size ? 'waiting' : entry.turn ? 'working' : 'idle');
        } else if (kind === 'turn/end' && entry.turn && data.turn_id === entry.turn) {
          const response = data.status === 'completed' && entry.finalized && !entry.toolContent ? entry.response : undefined;
          entry.turn = undefined; entry.approvals.clear();
          set(entry, data.status === 'failed' ? 'error' : 'idle', response);
          entry.response = '';
        } else if (kind === 'stop/interrupt') {
          summaries.cancel(entry); entry.turn = undefined; entry.response = ''; entry.approvals.clear(); set(entry, 'idle');
        } else if (kind === 'branch/end') {
          entry.closed = true; summaries.cancel(entry); void entry.reporter.close();
        } else if (kind === 'branch/start' || kind === 'branch/resume') set(entry, 'idle');
      });
      // Do not hold Session publication by awaiting activated() inside apply.
      void lifecycle.activated().then(published => {
        if (!published || closed) return;
        active = true;
        if (!entries.size) get('main');
        for (const entry of entries.values()) if (!entry.closed) entry.reporter.set(entry.state);
      }).catch(close);
    },
  };
}

/** Dim's process row mounts one advisory observer per Session. */
export default {
  name: 'AgentDiscordPresenceDim', inject: ['partRegistry', 'auxiliaryModel'],
  async apply(ctx: Context): Promise<void> {
    if (process.env.ADP_SUMMARY_WORKER === '1') return;
    const summaries = new Summaries(ctx.get<AuxiliaryModel>('auxiliaryModel'));
    ctx.effect(() => () => summaries.close());
    await ctx.get<{registerDefinition(scope: string, name: string, plugin: Plugin): Promise<void>}>('partRegistry')
      .registerDefinition('session', 'AgentDiscordPresenceSession', observer(summaries));
  },
} satisfies Plugin;
