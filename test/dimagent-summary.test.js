import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {extractDimagentReply, DimagentCompletion} from '../dist/dimagent.js';
import {SessionStore} from '../dist/store.js';
import {startDaemon} from '../dist/daemon.js';
import {request} from '../dist/client.js';
import {ipcPath} from './ipc-path.js';
import {dimagentSummaryValue} from '../dist/generation.js';

const message = (role, parts, runId = 'r1', extra = {}) => ({sessionId: 's', role, parts, metadata: {runId}, ...extra});
const exported = messages => ({version: '1', metadata: {id: 's', model: {modelId: 'current-model', provider: 'current-route'}}, messages});
const fixture = () => exported([
  message('user', [{type: 'text', text: 'private user prompt'}]),
  message('tool', [{type: 'text', text: 'private tool result'}]),
  message('assistant', [{type: 'thinking', text: 'private reasoning'}, {type: 'text', text: 'Completed the adapter.'}]),
]);
const event = (state = 'idle', updatedAt = Date.now()) => ({version: 1, agent: 'dimagent', sessionId: 's', state, updatedAt});
async function until(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await delay(5); } }

test('DimAgent export extraction selects the exact final reply and bounds Unicode', () => {
  assert.deepEqual(extractDimagentReply(fixture(), 's', 'r1'), {response: 'Completed the adapter.', model: 'current-model', provider: 'current-route'});
  const data = fixture(); data.messages.at(-1).parts = [{type: 'text', text: '🧋'.repeat(4100)}];
  assert.equal(Array.from(extractDimagentReply(data, 's', 'r1').response).length, 4000);
  assert.equal(extractDimagentReply(data, 'other-session', 'r1'), undefined);
  assert.equal(extractDimagentReply(data, 's', 'other-run'), undefined);
  assert.equal(extractDimagentReply(null, 's', 'r1'), undefined);
});

test('DimAgent export extraction rejects later runs, terminal notices, tool calls and reasoning-only replies', () => {
  const mutations = [
    data => data.messages.push(message('user', [{type: 'text', text: 'new request'}], 'r2')),
    data => data.messages.unshift(message('user', [], 'r1', {metadata: {runId: 'r1', kind: 'run_terminal', status: 'failed'}})),
    data => { data.messages.at(-1).parts.push({type: 'tool-call', name: 'exec'}); },
    data => { data.messages.at(-1).parts = [{type: 'thinking', text: 'not public'}]; },
    data => { data.messages.at(-1).metadata.kind = 'provider_retry'; },
    data => { data.messages = data.messages.filter(m => m.role !== 'user'); },
  ];
  for (const mutate of mutations) { const data = fixture(); mutate(data); assert.equal(extractDimagentReply(data, 's', 'r1'), undefined); }
});

test('native DimAgent summary parsing rejects incomplete, failed and tool-bearing runs', () => {
  const delta = {eventType: 'text:delta', payload: {delta: '{"topic":"Done","subtitle":""}'}};
  const end = {eventType: 'run:ended', payload: {status: 'completed'}};
  const lines = (...events) => events.map(e => JSON.stringify(e)).join('\n');
  assert.deepEqual(dimagentSummaryValue(lines({eventType: 'thinking:delta', payload: {delta: 'private reasoning'}}, delta, end)), {topic: 'Done', subtitle: ''});
  for (const events of [[delta], [delta, {...end, payload: {status: 'failed'}}],
    [delta, {eventType: 'tool:started'}, end], [delta, end, delta], [delta, end, end]]) {
    assert.throws(() => dimagentSummaryValue(lines(...events)));
  }
});

test('DimAgent completion reader cancels on new work and manual edits, and never resurrects sessions', async () => {
  for (const change of ['work', 'manual', 'close', 'disabled']) {
    const store = new SessionStore(); store.update(event()); let enabled = true; let release; let signal; const submitted = [];
    const reader = new DimagentCompletion(store, () => enabled, (_key, reply) => submitted.push(reply), async (_id, _run, s) => {
      signal = s; return new Promise(resolve => { release = resolve; });
    });
    reader.enqueue('dimagent:s', 'r1'); await until(() => !!release);
    const session = store.sessions.get('dimagent:s');
    if (change === 'work') store.update(event('working', session.updatedAt + 1));
    if (change === 'manual') store.setSummary('dimagent:s', {topic: 'My manual summary', subtitle: ''}, session.updatedAt, session.startedAt);
    if (change === 'close') store.update(event('closed', session.updatedAt + 1));
    if (change === 'disabled') enabled = false;
    reader.reconcile(); assert.equal(signal.aborted, true);
    release({response: 'Old reply'}); await until(() => !reader.status.active);
    assert.deepEqual(submitted, []); assert.equal(reader.status.discarded, 1); await reader.close();
  }
});

test('disabled DimAgent summaries skip export; capture failures reveal no source or provider output', async () => {
  const store = new SessionStore(); store.update(event()); let enabled = false; let calls = 0;
  const reader = new DimagentCompletion(store, () => enabled, () => assert.fail(), async () => { calls++; throw new Error('private export and credentials'); });
  reader.enqueue('dimagent:s', 'r1'); assert.equal(calls, 0);
  enabled = true; reader.enqueue('dimagent:s', 'r1'); await until(() => reader.failed === 1);
  assert.doesNotMatch(JSON.stringify(reader.status), /private export|credentials/); await reader.close();
});

test('real Stop hook schedules export off the hook path, reuses the model route and publishes only bounded assistant text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adp-dim-summary-')); const path = ipcPath(dir); const config = join(dir, 'config.json');
  await writeFile(config, '{"enabled":true}'); const old = process.env.ADP_CONFIG; process.env.ADP_CONFIG = config;
  const seen = []; let sourceCalls = 0;
  const daemon = await startDaemon({path,
    transport: {status: 'test', start() {}, stop() {}, setActivity() {}},
    dimagentRead: async (sessionId, runId) => {
      sourceCalls++; assert.equal(sessionId, 's'); assert.equal(runId, 'r1'); await delay(150);
      return extractDimagentReply(fixture(), sessionId, runId);
    },
    generate: async (agent, response, _signal, context) => { seen.push({agent, response, context}); return {topic: 'Automatic DimAgent summary', subtitle: ''}; },
  });
  t.after(async () => { await daemon.close(); if (old === undefined) delete process.env.ADP_CONFIG; else process.env.ADP_CONFIG = old; await rm(dir, {recursive: true, force: true}); });
  const child = spawn(process.execPath, ['dist/cli.js', 'hook', 'dimagent'], {env: {...process.env, AGENT_PRESENCE_SOCKET: path}, stdio: ['pipe', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  child.stdin.end(JSON.stringify({session_id: 's', hook_event_name: 'Stop', run_id: 'r1', prompt: 'never publish', cwd: '/private'}));
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0); assert.equal(output, '');
  await until(() => daemon.store.select()?.summary?.topic === 'Automatic DimAgent summary');
  assert.deepEqual(seen, [{agent: 'dimagent', response: 'Completed the adapter.', context: {model: 'current-model', provider: 'current-route'}}]);
  const status = await request({type: 'status'}, path);
  assert.equal(status.dimagentCapture.completed, 1); assert.equal(sourceCalls, 1);
  assert.doesNotMatch(JSON.stringify(status), /private|Completed the adapter|never publish/);
  await writeFile(config, '{"enabled":false}');
  await request({type: 'event', event: {...event(), updatedAt: Date.now() + 1}, dimagentRunId: 'r2'}, path);
  await delay(30); assert.equal(sourceCalls, 1);
});
