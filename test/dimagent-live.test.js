import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DimagentLive, dimagentActivity, taskGoal, extractDimagentModel} from '../dist/dimagent-live.js';
import {DEFAULT_SETTINGS} from '../dist/settings.js';
import {SessionStore} from '../dist/store.js';
import {startDaemon} from '../dist/daemon.js';
import {request} from '../dist/client.js';
import {buildPresencePrompt} from '../dist/prompts.js';
import {ipcPath} from './ipc-path.js';

const key = 'dimagent:s';
const event = (state, updatedAt) => ({version: 1, agent: 'dimagent', sessionId: 's', state, updatedAt});
async function until(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await delay(5); } }

test('active model lookup selects exact session metadata and excludes previews', () => {
  const rows = [{id: 'other', model: {modelId: 'wrong'}}, {id: 's', model: {modelId: 'm', provider: 'p'}, firstUserMessagePreview: 'private'}];
  assert.deepEqual(extractDimagentModel(rows, 's'), {model: 'm', provider: 'p'});
  assert.throws(() => extractDimagentModel(rows, 'missing'));
  assert.throws(() => extractDimagentModel({}, 's'));
  assert.throws(() => extractDimagentModel([{id: 's', model: {modelId: 123}}], 's'));
});

test('live hints bound/filter user goals and reduce tool data to fixed phases', () => {
  const hint = dimagentActivity({hook_event_name: 'UserPromptSubmit', prompt: 'Fix login token=secret123 at C:\\private\\app https://private.example'});
  assert.doesNotMatch(hint.goal, /secret123|private/);
  assert.equal(Array.from(taskGoal('🧋'.repeat(2100))).length, 2000);
  for (const [tool, phase] of [['read', 'reading'], ['edit', 'editing'], ['exec', 'command'], ['agent', 'delegating'], ['private tool', 'tool']]) {
    assert.deepEqual(dimagentActivity({hook_event_name: 'PreToolUse', tool_name: tool, tool_input: 'secret', tool_response: 'secret'}), {kind: 'progress', phase});
  }
  const input = buildPresencePrompt({agent: 'dimagent', response: 'Fix login', purpose: 'task'});
  assert.match(input.systemPrompt, /not completed work/); assert.deepEqual(JSON.parse(input.prompt), {agent: 'DimAgent', userGoal: 'Fix login'});
});

test('task title generation survives working/waiting events; phases coalesce without extra model calls', async () => {
  const store = new SessionStore(); store.update(event('working', 1000), 1000);
  let now = 1000; let release; let signal; let calls = 0;
  const live = new DimagentLive(store, () => DEFAULT_SETTINGS, async (_agent, source, s, context) => {
    calls++; signal = s; assert.equal(source, 'Fix the adapter'); assert.equal(context.purpose, 'task');
    return new Promise(resolve => { release = resolve; });
  }, () => {}, async () => ({model: 'm', provider: 'p'}), () => now);
  live.handle(key, {kind: 'start', goal: 'Fix the adapter'}); await until(() => !!release);
  assert.equal(live.display(store.select()).summary.topic, '正在分析任务');
  store.update(event('working', 2000), 2000); live.reconcile();
  live.handle(key, {kind: 'progress', phase: 'reading'});
  assert.equal(live.display(store.select()).summary.subtitle, '分析实现方案');
  now += 5000; assert.equal(live.display(store.select()).summary.subtitle, '阅读项目文件');
  store.update(event('waiting', 3000), 3000); live.handle(key, {kind: 'progress', phase: 'waiting'}); live.reconcile();
  assert.equal(signal.aborted, false); assert.equal(live.display(store.select()).summary.subtitle, '等待工具授权');
  release({topic: 'Adapting task presence', subtitle: 'Goal overview'}); await until(() => live.completed === 1);
  assert.equal(live.display(store.select()).summary.topic, 'Adapting task presence');
  assert.equal(live.display(store.select()).summary.subtitle, '等待工具授权'); assert.equal(calls, 1);
  await live.close();
});

test('new task, stop, manual edits and disabled live mode discard late task titles', async () => {
  for (const change of ['new-task', 'stop', 'manual', 'disabled', 'config']) {
    const store = new SessionStore(); store.update(event('working', 1000), 1000);
    let settings = {...DEFAULT_SETTINGS}; let release; let signal;
    const live = new DimagentLive(store, () => settings, async (_a, _g, s) => { signal = s; return new Promise(r => { release = r; }); }, () => {}, async () => ({model: 'm'}));
    live.handle(key, {kind: 'start', goal: 'Old task'}); await until(() => !!release);
    if (change === 'new-task') live.handle(key, {kind: 'start', goal: ''});
    if (change === 'stop') { store.update(event('idle', 2000), 2000); live.handle(key, {kind: 'finish'}); }
    if (change === 'manual') { store.setSummary(key, {topic: 'Manual title', subtitle: 'Manual subtitle'}, 1000, 1000); live.manual(key); }
    if (change === 'disabled') settings = {...settings, liveSummaries: false};
    if (change === 'config') settings = {...settings, customPrompt: 'Changed style'};
    live.reconcile(); assert.equal(signal.aborted, true);
    release({topic: 'Late old title', subtitle: ''}); await until(() => !live.status.active);
    assert.notEqual(store.select().summary.topic, 'Late old title');
    if (change === 'manual') { assert.equal(live.allowsCompletion(key), false); assert.equal(live.display(store.select()).summary.subtitle, 'Manual subtitle'); }
    await live.close();
  }
});

test('liveSummaries off keeps completion available and never reads a goal model', async () => {
  const store = new SessionStore(); store.update(event('working', 1000), 1000);
  const live = new DimagentLive(store, () => ({...DEFAULT_SETTINGS, liveSummaries: false}), async () => assert.fail(), () => {}, async () => assert.fail());
  live.handle(key, {kind: 'start', goal: 'Do not generate'});
  assert.equal(store.select().summary, undefined); assert.equal(live.allowsCompletion(key), true);
  await live.close();
});

test('real CLI hooks display a title during work, retain manual ownership at Stop and reset on next task', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adp-live-')); const path = ipcPath(dir); const config = join(dir, 'config.json');
  await writeFile(config, '{}'); const old = process.env.ADP_CONFIG; process.env.ADP_CONFIG = config;
  const seen = []; let captures = 0;
  const daemon = await startDaemon({path, transport: {status: 'test', start() {}, stop() {}, setActivity() {}},
    dimagentModelRead: async () => ({model: 'm', provider: 'p'}),
    dimagentRead: async () => { captures++; return {response: 'Completed the task', model: 'm', provider: 'p'}; },
    generate: async (_a, source, _s, context) => { seen.push({source, purpose: context?.purpose}); return {topic: context?.purpose === 'task' ? 'Working on task' : 'Completed task', subtitle: ''}; },
  });
  t.after(async () => { await daemon.close(); if (old === undefined) delete process.env.ADP_CONFIG; else process.env.ADP_CONFIG = old; await rm(dir, {recursive: true, force: true}); });
  async function hook(name, extra = {}) {
    const child = spawn(process.execPath, ['dist/cli.js', 'hook', 'dimagent'], {env: {...process.env, AGENT_PRESENCE_SOCKET: path}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.stdin.end(JSON.stringify({session_id: 's', hook_event_name: name, ...extra}));
    assert.equal(await new Promise(r => child.on('close', r)), 0); assert.equal(output, '');
  }
  await hook('UserPromptSubmit', {prompt: 'Implement task presence token=private123'});
  await until(() => daemon.store.select()?.summary?.topic === 'Working on task');
  await hook('PermissionRequest'); let status = await request({type: 'status'}, path);
  assert.equal(status.activity.name, 'Working on task'); assert.equal(status.activity.state, '等待工具授权');
  assert.doesNotMatch(JSON.stringify(status), /Implement task presence|private123/);
  const s = daemon.store.select();
  await request({type: 'summary', key, summary: {topic: 'Keep my title', subtitle: 'Keep subtitle'}, expectedUpdatedAt: s.updatedAt, expectedStartedAt: s.startedAt}, path);
  await hook('PostToolUse', {tool_name: 'exec'}); await hook('Stop', {run_id: 'r1'}); await delay(20);
  assert.equal(captures, 0); assert.equal((await request({type: 'status'}, path)).activity.name, 'Keep my title');
  await hook('UserPromptSubmit', {prompt: 'Next task'}); await until(() => seen.length === 2);
  await hook('Stop', {run_id: 'r2'}); await until(() => daemon.store.select()?.summary?.topic === 'Completed task');
  assert.equal(captures, 1); assert.deepEqual(seen.map(s => s.purpose), ['task', 'task', undefined]);
});
