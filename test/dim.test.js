import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import plugin, {dimSessionId} from 'agent-discord-presence/dim';
import {startDaemon} from '../dist/daemon.js';
import {request} from '../dist/client.js';
import {ipcPath} from './ipc-path.js';

async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for Dim presence');
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
};

test('Rust Dim plugin lifecycle, native summaries, privacy, cancellation and unload through ADP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adp-dim-'));
  const previous = {socket: process.env.AGENT_PRESENCE_SOCKET, config: process.env.ADP_CONFIG};
  process.env.AGENT_PRESENCE_SOCKET = ipcPath(directory);
  process.env.ADP_CONFIG = join(directory, 'config.json');
  await writeFile(process.env.ADP_CONFIG, '{}');
  const activities = []; const calls = [];
  let native = async () => ({text: '{"topic":"Adapting Rust Dim","subtitle":"Verified native events"}', stopReason: 'end_turn'});
  const daemon = await startDaemon({path: process.env.AGENT_PRESENCE_SOCKET,
    transport: {status: 'test', start() {}, stop() {}, setActivity(a) { activities.push(a); }},
    dimagentRead() { assert.fail('Must not read a legacy Dim export'); },
    dimagentModelRead() { assert.fail('Must not read legacy Dim metadata'); },
  });
  const rootEffects = []; const sessionEffects = []; const listeners = new Map();
  const activated = deferred(); const closing = deferred();
  let observer;
  await plugin.apply({
    get(name) {
      if (name === 'auxiliaryModel') return {async complete(call, cancelled) { calls.push(call); return native(call, cancelled); }};
      if (name === 'partRegistry') return {async registerDefinition(scope, _name, definition) { assert.equal(scope, 'session'); observer = definition; }};
      assert.fail(name);
    }, effect(fn) { rootEffects.push(fn()); },
  });
  await observer.apply({
    get(name) {
      if (name === 'sessionIdentity') return {get: async () => ({sessionId: 'S'})};
      if (name === 'sessionConfig') return {get: async () => ({model: {modelId: 'original', providerId: 'local'}})};
      if (name === 'sessionLifecycle') return {activated: () => activated.promise, closing: () => closing.promise};
      assert.fail(name);
    }, effect(fn) { sessionEffects.push(fn()); }, on(name, fn) { listeners.set(name, fn); },
  });
  t.after(async () => {
    closing.resolve(); await Promise.all(sessionEffects.map(fn => fn())); await Promise.all(rootEffects.map(fn => fn()));
    await daemon.close(); await rm(directory, {recursive: true, force: true});
    for (const [name, value] of Object.entries({AGENT_PRESENCE_SOCKET: previous.socket, ADP_CONFIG: previous.config})) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const key = branch => `dimagent:${dimSessionId('S', branch)}`;
  const session = (branch = 'main') => daemon.store.sessions.get(key(branch));
  const emit = (kind, data = {}, branchId = 'main') => {
    const [type, name] = kind.split('/'); listeners.get('session/S')({kind: 'event', branchId, event: {type, name, data}});
  };
  const start = (id = 'T', branch = 'main') => {
    emit('turn/start', {turn_id: id}, branch); emit('step/model-start', {turn_id: id, request_id: `R-${id}`}, branch);
  };
  const content = (text, id = 'T', branch = 'main', extra = []) => emit('step/model-content', {
    turn_id: id, request_id: `R-${id}`, content: [{type: 'text', text}, {type: 'thinking', thinking: 'private reasoning'}, ...extra],
  }, branch);
  const end = (id = 'T', status = 'completed', branch = 'main') => {
    emit('step/model-output-end', {turn_id: id, request_id: `R-${id}`, status, finish_reason: 'end_turn'}, branch);
    emit('turn/end', {turn_id: id, status}, branch);
  };

  emit('branch/start'); assert.equal(daemon.store.sessions.size, 0);
  activated.resolve(true); await until(() => session()?.state === 'idle');
  assert.equal(activities.at(-1).name, 'Coding with DimAgent');
  start(); await until(() => session()?.state === 'working');
  emit('approval/request', {approval_id: 'one', call: {secret: 'private tool'}});
  emit('approval/request', {approval_id: 'two'}); await until(() => session()?.state === 'waiting');
  emit('approval/respond', {approval_id: 'one'}); await delay(25); assert.equal(session().state, 'waiting');
  emit('approval/cancelled', {approval_id: 'two'}); await until(() => session()?.state === 'working');
  start('C', 'child'); await until(() => session('child')?.state === 'working');
  emit('branch/end', {}, 'child'); await until(() => !session('child')); assert.equal(session().state, 'working');
  emit('context/configured', {settings: {modelId: 'current', providerId: 'configured'}});
  content('Completed adapter 😀' + 'x'.repeat(5000)); end();
  await until(() => session()?.summary?.topic === 'Adapting Rust Dim');
  assert.deepEqual(calls[0].model, {modelId: 'current', providerId: 'configured'});
  assert.deepEqual(Object.keys(calls[0].request).sort(), ['maxOutputTokens', 'messages', 'system']);
  assert.equal(calls[0].request.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /private reasoning|private tool/);
  assert.ok(JSON.stringify(calls[0]).length < 14000);
  assert.equal((await request({type: 'status'})).dimagentCapture.completed, 0);
  assert.equal((await request({type: 'status'})).generation.completed, 0);

  const callCount = calls.length;
  start('tool'); content('Not a final reply', 'tool', 'main', [{type: 'tool_use', name: 'exec', input: {secret: 1n}}]); end('tool');
  await until(() => session()?.state === 'idle'); await delay(30); assert.equal(calls.length, callCount);
  start('failed'); content('partial', 'failed'); end('failed', 'failed'); await until(() => session()?.state === 'error');
  start('cancelled'); content('partial', 'cancelled'); end('cancelled', 'cancelled'); await until(() => session()?.state === 'idle');
  start('interrupt'); emit('stop/interrupt'); await until(() => session()?.state === 'idle');
  assert.equal(calls.length, callCount);

  let cancelObserved = false;
  native = async (_call, cancelled) => { await cancelled(); cancelObserved = true; throw new Error('cancelled'); };
  start('old'); content('Old reply', 'old'); end('old'); await until(() => calls.length === callCount + 1);
  start('new'); await until(() => cancelObserved); assert.equal(session().summary.topic, 'Adapting Rust Dim');
  end('new', 'cancelled'); await until(() => session()?.state === 'idle');

  const held = deferred(); native = () => held.promise;
  start('manual'); content('Reply before a manual edit', 'manual'); end('manual'); await until(() => calls.length === callCount + 2);
  const target = session();
  await request({type: 'summary', key: key('main'), summary: {topic: 'Manual title', subtitle: ''},
    expectedUpdatedAt: target.updatedAt, expectedStartedAt: target.startedAt});
  held.resolve({text: '{"topic":"Obsolete title","subtitle":""}', stopReason: 'end_turn'});
  await delay(70); assert.equal(session().summary.topic, 'Manual title');

  native = async () => ({text: '{"topic":"Streaming reply","subtitle":""}', stopReason: 'end_turn'});
  start('deltas');
  emit('step/text', {turn_id: 'older', request_id: 'older', delta: 'PRIVATE_OLD_REPLY'});
  emit('step/text', {turn_id: 'deltas', request_id: 'R-deltas', delta: 'Hello '});
  emit('step/text', {turn_id: 'deltas', request_id: 'R-deltas', delta: 'world 😀'});
  end('deltas'); await until(() => session()?.summary?.topic === 'Streaming reply');
  assert.match(calls.at(-1).request.messages[0].content, /Hello world 😀/);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_OLD_REPLY/);

  native = async () => ({text: '{"topic":"Truncated output","subtitle":""}', stopReason: 'max_tokens'});
  start('bad-summary'); content('Completed source', 'bad-summary'); end('bad-summary');
  await until(() => calls.length === callCount + 4); await delay(25);
  assert.equal(session().summary.topic, 'Streaming reply');

  const externalCalls = [];
  const external = createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      externalCalls.push(JSON.parse(data)); res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: '{"topic":"External summary","subtitle":""}'}}]}));
    });
  });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => external.close(resolve)));
  await writeFile(process.env.ADP_CONFIG, JSON.stringify({agents: {dimagent: {service: 'openai-compatible', model: 'override',
    apiKeyEnv: '', baseUrl: `http://127.0.0.1:${external.address().port}/v1`}}}));
  start('external'); content('External completed reply', 'external'); end('external');
  await until(() => session()?.summary?.topic === 'External summary');
  assert.equal(externalCalls[0].model, 'override'); assert.equal(externalCalls[0].tools, undefined);
  assert.equal(calls.length, callCount + 4);

  await writeFile(process.env.ADP_CONFIG, '{"enabled":false}');
  start('disabled'); content('Should not generate', 'disabled'); end('disabled'); await until(() => session()?.state === 'idle');
  await delay(30); assert.equal(calls.length, callCount + 4);
  closing.resolve(); await until(() => daemon.store.sessions.size === 0);
  emit('turn/start', {turn_id: 'after-close'}); await delay(20); assert.equal(daemon.store.sessions.size, 0);
  assert.doesNotMatch(JSON.stringify(activities), /private reasoning|private tool|Old reply/);
});

test('Rust Dim package uses a separate native manifest and namespaced branch identity', async () => {
  const manifest = JSON.parse(await readFile('plugins/dim/dim-plugin.json', 'utf8'));
  assert.deepEqual(manifest.code.inject, plugin.inject);
  assert.equal((await import('../plugins/dim/index.js')).default, plugin);
  assert.notEqual(dimSessionId('a:b', 'c'), dimSessionId('a', 'b:c'));
  assert.notEqual(dimSessionId('S', 'main'), dimSessionId('S', 'child'));
  assert.ok(dimSessionId('s'.repeat(300), 'b'.repeat(300)).length <= 256);
});

test('Rust Dim auxiliary workers mount no observers', async () => {
  const old = process.env.ADP_SUMMARY_WORKER; process.env.ADP_SUMMARY_WORKER = '1';
  try { await plugin.apply({get() { assert.fail(); }, effect() { assert.fail(); }}); }
  finally { if (old === undefined) delete process.env.ADP_SUMMARY_WORKER; else process.env.ADP_SUMMARY_WORKER = old; }
});
