import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {hookEvent, hookConfig, hookEvents} from '../dist/adapters/hooks.js';
import {startDaemon} from '../dist/daemon.js';
import {request} from '../dist/client.js';
import {ipcPath} from './ipc-path.js';

// Fields and event names from DimAgent 0.5.21's bundled
// agent/src/hooks/command/{config,protocol}.ts. No invented reply/end events.
const payload = (hook_event_name, extra = {}) => ({hook_event_name, session_id: 'main',
  agent_id: 'agent-main', model: 'current-model', cwd: '/private/project',
  transcript_path: '/private/transcript', permission_mode: 'normal', ...extra});

test('DimAgent maps its published command hooks without exposing prompts or tool data', () => {
  const states = {SessionStart: 'idle', UserPromptSubmit: 'working', PreToolUse: 'working',
    PermissionRequest: 'waiting', PostToolUse: 'working', PreCompact: 'working', PostCompact: 'working', Stop: 'idle'};
  for (const [name, state] of Object.entries(states)) {
    const event = hookEvent('dimagent', payload(name, {prompt: 'private prompt',
      tool_input: {secret: 'tool secret'}, tool_response: 'private result', last_assistant_message: 'not in host contract'}), 1000);
    assert.deepEqual(event, {version: 1, agent: 'dimagent', sessionId: 'main', state, updatedAt: 1000, model: 'current-model'});
  }
  for (const name of ['SessionEnd', 'Interrupt', 'StopFailure', 'Notification', 'PostToolUseFailure']) {
    assert.equal(hookEvent('dimagent', payload(name)), undefined);
  }
  assert.equal(hookEvent('dimagent', payload('Stop', {session_id: ''})), undefined);
});

test('DimAgent child lifecycle uses agent_id and never idles or closes the parent', () => {
  for (const [name, state] of [['SubagentStart', 'working'], ['SubagentStop', 'closed']]) {
    assert.deepEqual(hookEvent('dimagent', payload(name, {agent_id: 'child'}), 1000),
      {version: 1, agent: 'dimagent', sessionId: 'child', state, updatedAt: 1000});
    for (const agent_id of [undefined, '', 'main']) assert.equal(hookEvent('dimagent', payload(name, {agent_id})), undefined);
  }
});

test('DimAgent plugin and generated config register exactly the host-supported hooks', async () => {
  const root = 'plugins/dimagent/agent-discord-presence';
  const manifest = JSON.parse(await readFile(`${root}/.codex-plugin/plugin.json`, 'utf8'));
  assert.equal(manifest.name, 'agent-discord-presence');
  assert.equal(manifest.hooks, 'hooks/hooks.json');
  const bundled = JSON.parse(await readFile(`${root}/hooks/hooks.json`, 'utf8'));
  assert.deepEqual(bundled, hookConfig('dimagent'));
  const generated = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'config', 'dimagent'], {encoding: 'utf8'}));
  assert.deepEqual(Object.keys(generated.hooks), hookEvents.dimagent);
  assert.ok(generated.hooks.Stop[0].hooks[0].command.includes(process.execPath));
});

test('DimAgent CLI hooks update the daemon, isolate children, expire silently, and fail open', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adp-dimagent-'));
  const path = ipcPath(dir);
  const config = join(dir, 'config.json'); await writeFile(config, '{"enabled":false}');
  const activities = [];
  const staleMs = 30 * 60_000;
  const daemon = await startDaemon({path, staleMs,
    transport: {status: 'test', start() {}, stop() {}, setActivity(a) { activities.push(a); }}});
  t.after(async () => { await daemon.close(); await rm(dir, {recursive: true, force: true}); });
  async function hook(data, extra = {}, socket = path) {
    const child = spawn(process.execPath, ['dist/cli.js', 'hook', 'dimagent'], {
      env: {...process.env, ADP_CONFIG: config, AGENT_PRESENCE_SOCKET: socket, ...extra}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.stdin.end(typeof data === 'string' ? data : JSON.stringify(data));
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 0);
    assert.equal(output, '');
  }
  const state = id => daemon.store.sessions.get(`dimagent:${id}`)?.state;
  await hook(payload('SessionStart')); assert.equal(state('main'), 'idle');
  assert.equal(activities.at(-1).name, 'Coding with DimAgent');
  await hook(payload('UserPromptSubmit', {prompt: 'never publish'})); assert.equal(state('main'), 'working');
  await hook(payload('PermissionRequest', {tool_input: {secret: 'never publish'}})); assert.equal(state('main'), 'waiting');
  await hook(payload('PostToolUse')); assert.equal(state('main'), 'working');
  await hook(payload('SubagentStart', {agent_id: 'child'})); assert.equal(state('child'), 'working');
  await hook(payload('SubagentStop', {agent_id: 'child'})); assert.equal(state('child'), undefined); assert.equal(state('main'), 'working');
  await hook(payload('Stop')); assert.equal(state('main'), 'idle');
  const session = daemon.store.sessions.get('dimagent:main');
  await request({type: 'summary', key: 'dimagent:main', summary: {topic: 'Adapting DimAgent', subtitle: ''},
    expectedUpdatedAt: session.updatedAt, expectedStartedAt: session.startedAt}, path);
  assert.equal(activities.at(-1).name, 'Adapting DimAgent');
  const before = daemon.store.sessions.get('dimagent:main').updatedAt;
  await hook(payload('UserPromptSubmit'), {ADP_SUMMARY_WORKER: '1'});
  assert.equal(daemon.store.sessions.get('dimagent:main').updatedAt, before);
  await hook('invalid JSON'); await hook(null);
  assert.doesNotMatch(JSON.stringify(activities), /private|never publish/);
  daemon.store.sweep(daemon.store.sessions.get('dimagent:main').lastSeen + staleMs + 1); assert.equal(state('main'), undefined);
  await hook(payload('UserPromptSubmit'), {}, ipcPath(dir, 'offline.sock'));
});
