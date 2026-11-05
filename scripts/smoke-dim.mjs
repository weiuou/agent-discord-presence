// node scripts/smoke-dim.mjs /absolute/path/to/Rust/dimcode[.exe]
// Real Dim runtime, isolated home, local model fixture and fake Discord transport.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startDaemon} from '../dist/daemon.js';
import {ipcPath} from '../test/ipc-path.js';

const command = process.argv[2];
if (!command) throw new Error('Pass the absolute path to the Rust Dim executable.');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'adp-dim-smoke-'));
const previous = {ADP_CONFIG: process.env.ADP_CONFIG, AGENT_PRESENCE_SOCKET: process.env.AGENT_PRESENCE_SOCKET};
process.env.ADP_CONFIG = join(directory, 'adp.json');
process.env.AGENT_PRESENCE_SOCKET = ipcPath(directory);
await writeFile(process.env.ADP_CONFIG, '{}');
const states = new Set(); const summaries = [];
let daemon;
let fixtureFailure;
const model = createServer((req, res) => {
  let body = '';
  req.on('data', data => { body += data; });
  req.on('end', async () => {
    try {
      const input = JSON.parse(body);
      const summary = JSON.stringify(input).includes('Return only JSON matching this schema');
      if (summary) {
        summaries.push(input);
        assert.ok(!input.tools?.length);
        assert.match(JSON.stringify(input), /Rust Dim fixture completed/);
        assert.doesNotMatch(JSON.stringify(input), /PRIVATE_OPERATOR_SENTINEL/);
      } else await delay(300);
      const text = summary ? '{"topic":"Testing Rust Dim","subtitle":"Native plugin verified"}' : 'Rust Dim fixture completed.';
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'dim-fixture', object: 'chat.completion.chunk',
        created: 1, model: 'adp-test', choices: [{index: 0, delta, finish_reason}]})}\n\n`);
      chunk({role: 'assistant', content: text}); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
    } catch (error) { fixtureFailure = error; res.writeHead(500); res.end(); }
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const home = join(directory, 'home'); const workspace = join(directory, 'workspace'); const config = join(directory, 'model.json');
await mkdir(workspace);
await writeFile(config, JSON.stringify({defaultModel: {providerId: 'local', modelId: 'adp-test'}, providers: [{
  id: 'local', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{
    id: 'adp-test', contextWindow: 128000, maxOutputTokens: 4096, config: {maxTokens: 2048},
  }],
}]}));
const common = ['--home', home, '--model-config', config, '--cwd', workspace];
async function run(args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...common, ...args], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, DIMCODE_UPDATE_CHECK: '0', ...(process.platform === 'win32' ? {
        // alpha.19 passes a verbatim Windows path to npm's entry module.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main'].filter(Boolean).join(' '),
      } : {})}});
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Dim command timed out: ${args.join(' ')}`)); }, timeout);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    // The detached Windows App Server can inherit the CLI's output handles.
    child.on('exit', code => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      code === 0 ? resolve(output) : reject(new Error(`Dim exited ${code}: ${output}`));
    });
  });
}
try {
  daemon = await startDaemon({path: process.env.AGENT_PRESENCE_SOCKET,
    transport: {status: 'test', start() {}, stop() {}, setActivity(activity) { if (activity) states.add(activity.details); }}});
  await run(['runtime', 'config', 'node', '--source', 'system']);
  console.log('Installing the isolated Dim Node runtime...');
  await run(['runtime', 'install', 'node'], 240_000);
  console.log(await run(['plugin', 'install', join(root, 'plugins/dim')]));
  const loadedBy = Date.now() + 180_000;
  for (;;) {
    const plugins = await run(['plugin', 'list']);
    if (/agent-discord-presence\s+use=agent-discord-presence\s+running/.test(plugins)) break;
    if (Date.now() > loadedBy) throw new Error(`Dim plugin did not load:\n${plugins}\n${await run(['runtime', 'list'])}`);
    await delay(1000);
  }
  console.log('Dim plugin running; sending the fixture prompt...');
  await run(['exec', '--json', '--permission', 'read-only', '-p', 'PRIVATE_OPERATOR_SENTINEL: run the public fixture.']);
  const deadline = Date.now() + 15_000;
  while (![...daemon.store.sessions.values()].some(s => s.summary?.topic === 'Testing Rust Dim') && Date.now() < deadline) await delay(50);
  if (fixtureFailure) throw fixtureFailure;
  assert.ok(summaries.length > 0, 'The native auxiliary service must generate a summary');
  assert.ok([...daemon.store.sessions.values()].some(s => s.summary?.topic === 'Testing Rust Dim'));
  assert.ok(states.has('Working'));
  assert.ok(states.has('Ready for a prompt'));
  console.log(JSON.stringify({result: 'passed', summaries: summaries.length, states: [...states]}, null, 2));
} catch (error) {
  console.error(JSON.stringify({states: [...states], sessions: [...(daemon?.store.sessions.values() ?? [])]}, null, 2));
  try { console.error((await readFile(join(home, 'rust/daemon.log'), 'utf8')).slice(-12000)); } catch {}
  throw error;
} finally {
  try { await run(['daemon', 'stop'], 10_000); } catch {}
  await daemon?.close(); await new Promise(resolve => model.close(resolve));
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const withinTemp = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
  await rm(directory, {recursive: true, force: true});
}
