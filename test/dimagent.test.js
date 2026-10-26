import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {hookEvent, hookConfig, hookEvents} from '../dist/adapters/hooks.js';
import {startDaemon} from '../dist/daemon.js';
import {request} from '../dist/client.js';

const payload = (hook_event_name, extra = {}) => ({hook_event_name, session_id: 'main',
  agent_id: 'agent-main', model: 'current-model', cwd: '/private/project',
  transcript_path: '/private/transcript', ...extra});

test('DimAgent maps supported hooks without leaking prompts, tool data or invented replies', () => {
  for (const [name, state] of Object.entries({SessionStart: 'idle', UserPromptSubmit: 'working', PreToolUse: 'working',
    PermissionRequest: 'waiting', PostToolUse: 'working', PreCompact: 'working', PostCompact: 'working', Stop: 'idle'})) {
    assert.deepEqual(hookEvent('dimagent', payload(name, {prompt: 'private', tool_input: {secret: 'private'},
      tool_response: 'private', last_assistant_message: 'not part of the host contract'}), 1000),
    {version: 1, agent: 'dimagent', sessionId: 'main', state, updatedAt: 1000, model: 'current-model'});
  }
  assert.equal(hookEvent('dimagent', payload('SessionStart', {source: 'compact'}), 1000).state, 'working');
  for (const name of ['SessionEnd', 'Interrupt', 'StopFailure', 'Notification', 'PostToolUseFailure']) {
    assert.equal(hookEvent('dimagent', payload(name)), undefined);
  }
  assert.equal(hookEvent('dimagent', payload('Stop', {session_id: ''})), undefined);
});

test('DimAgent child lifecycle preserves the parent session', () => {
  for (const [name, state] of [['SubagentStart', 'working'], ['SubagentStop', 'closed']]) {
    assert.deepEqual(hookEvent('dimagent', payload(name, {agent_id: 'child'}), 1000),
      {version: 1, agent: 'dimagent', sessionId: 'child', state, updatedAt: 1000});
    for (const agent_id of [undefined, '', 'main']) assert.equal(hookEvent('dimagent', payload(name, {agent_id})), undefined);
  }
});

test('DimAgent plugin and config use the existing hook command', async () => {
  const root = 'plugins/dimagent/agent-discord-presence';
  const manifest = JSON.parse(await readFile(`${root}/.codex-plugin/plugin.json`, 'utf8'));
  assert.equal(manifest.hooks, 'hooks/hooks.json');
  assert.deepEqual(JSON.parse(await readFile(`${root}/hooks/hooks.json`, 'utf8')), hookConfig('dimagent'));
  if (process.platform === 'win32') {
    assert.throws(() => execFileSync(process.execPath, ['dist/cli.js', 'config', 'dimagent'], {stdio: 'pipe'}), /bundled plugin hooks/);
  } else {
    const config = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'config', 'dimagent'], {encoding: 'utf8'}));
    assert.deepEqual(Object.keys(config.hooks), hookEvents.dimagent);
  }
});

test('DimAgent hooks use the unchanged daemon, manual summaries and silence expiry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adp-dimagent-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\adp-dimagent-${process.pid}-${Date.now()}` : join(dir, 'service.sock');
  const config = join(dir, 'config.json'); await writeFile(config, '{}');
  const previous = process.env.ADP_CONFIG; process.env.ADP_CONFIG = config;
  const activities = []; let modelCalls = 0;
  const daemon = await startDaemon({path, generate: async () => { modelCalls++; assert.fail('Lifecycle hooks must not invent a completed reply'); },
    transport: {status: 'test', start() {}, stop() {}, setActivity(a) { activities.push(a); }}});
  t.after(async () => { await daemon.close(); if (previous === undefined) delete process.env.ADP_CONFIG; else process.env.ADP_CONFIG = previous; await rm(dir, {recursive: true, force: true}); });
  async function hook(data, extra = {}, socket = path) {
    const child = spawn(process.execPath, ['dist/cli.js', 'hook', 'dimagent'], {
      env: {...process.env, AGENT_PRESENCE_SOCKET: socket, ...extra}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.stdin.end(JSON.stringify(data));
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 0);
    assert.equal(output, '');
  }
  const state = id => daemon.store.sessions.get(`dimagent:${id}`)?.state;
  for (const [name, expected] of [['SessionStart', 'idle'], ['UserPromptSubmit', 'working'], ['PermissionRequest', 'waiting'], ['PostToolUse', 'working']]) {
    await hook(payload(name, {prompt: 'private', tool_input: {secret: 'private'}})); assert.equal(state('main'), expected);
  }
  await hook(payload('SubagentStart', {agent_id: 'child'})); assert.equal(state('child'), 'working');
  await hook(payload('SubagentStop', {agent_id: 'child'})); assert.equal(state('child'), undefined); assert.equal(state('main'), 'working');
  await hook(payload('Stop', {last_assistant_message: 'private'})); assert.equal(state('main'), 'idle'); assert.equal(modelCalls, 0);
  assert.equal(activities.at(-1).name, 'Coding with DimAgent'); assert.equal(activities.at(-1).details, 'Ready for a prompt');
  const s = daemon.store.sessions.get('dimagent:main');
  await request({type: 'summary', key: 'dimagent:main', summary: {topic: 'Manual task title', subtitle: ''}, expectedUpdatedAt: s.updatedAt, expectedStartedAt: s.startedAt}, path);
  assert.equal(activities.at(-1).name, 'Manual task title');
  await hook(payload('UserPromptSubmit'), {ADP_SUMMARY_WORKER: '1'}); assert.equal(state('main'), 'idle');
  await hook(null); assert.doesNotMatch(JSON.stringify(activities), /private/);
  daemon.store.sweep(s.lastSeen + 30 * 60_000 + 1); assert.equal(state('main'), undefined);
  const offline = process.platform === 'win32' ? `${path}-offline` : join(dir, 'offline.sock');
  await hook(payload('UserPromptSubmit'), {}, offline);
});
