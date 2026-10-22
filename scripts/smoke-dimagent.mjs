// Optional real-host check: node scripts/smoke-dimagent.mjs /absolute/path/to/dim
// Uses a temporary DimAgent home, a local fake model, and a fake Discord transport.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startDaemon} from '../dist/daemon.js';
import {ipcPath} from '../test/ipc-path.js';

const command = process.argv[2];
if (!command) throw new Error('Pass the absolute path to the DimAgent executable (dim or dimcode.exe).');
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'adp-dimagent-smoke-'));
const previous = process.env.ADP_CONFIG;
process.env.ADP_CONFIG = join(dir, 'adp.json');
await writeFile(process.env.ADP_CONFIG, '{"enabled":false}');
const states = [];
let calls = 0;
const model = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    calls++;
    const input = JSON.parse(body);
    assert.equal(input.model, 'adp-test');
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'adp-smoke', object: 'chat.completion.chunk',
      created: 1, model: 'adp-test', choices: [{index: 0, delta, finish_reason}]})}\n\n`);
    chunk({role: 'assistant', content: 'Local presence smoke test completed.'});
    chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
});
let daemon;
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const socket = ipcPath(dir);
  daemon = await startDaemon({path: socket, transport: {status: 'test', start() {}, stop() {}, setActivity(a) { if (a) states.push(a.details); }}});
  const env = {...process.env, DIMCODE_HOME: join(dir, 'home'), DIMCODE_CLI_BRAND: 'dim',
    DIMCODE_DISABLE_AUTOUPDATE: '1', AGENT_PRESENCE_SOCKET: socket};
  const workspace = join(dir, 'workspace'); await mkdir(workspace);
  async function run(exe, args) {
    const child = spawn(exe, args, {cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(code, 0, `${args.join(' ')}: ${stderr || stdout}`);
      return stdout;
    } finally { clearTimeout(timer); }
  }
  const version = (await run(command, ['version'])).trim();
  const plugin = join(dir, 'presence plugin');
  await cp(join(root, 'plugins/dimagent/agent-discord-presence'), plugin, {recursive: true});
  // Use absolute paths so the test does not need a global npm installation.
  const hooks = JSON.parse(await run(process.execPath, [join(root, 'dist/cli.js'), 'config', 'dimagent']));
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify(hooks));
  await run(command, ['plugin', 'install', plugin]);
  // 0.5.21's hooks list only enumerates user/project files, not plugin hooks.
  const installed = JSON.parse(await readFile(join(env.DIMCODE_HOME, 'plugins/agent-discord-presence/.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(installed.hooks, 'hooks/hooks.json');
  await run(command, ['provider', 'add', 'adp-test', '--adapter', 'openai', '--base-url',
    `http://127.0.0.1:${model.address().port}/v1`, '--api-key', 'local-fake-key', '--model', 'adp-test']);
  await run(command, ['exec', '--provider', 'adp-test', '--model', 'adp-test', '--policy', 'read-only', '--tools', 'read', 'Run the local presence test.']);
  assert.ok(calls > 0, 'Host must call the local model');
  assert.ok(states.includes('Working'), 'UserPromptSubmit must reach ADP');
  assert.ok(states.includes('Ready for a prompt'), 'SessionStart/Stop must reach ADP');
  const session = [...daemon.store.sessions.values()].find(s => s.agent === 'dimagent');
  assert.equal(session?.state, 'idle');
  await run(process.execPath, [join(root, 'dist/cli.js'), 'summary', `dimagent:${session.sessionId}`, 'Testing DimAgent']);
  assert.equal(session.summary?.topic, 'Testing DimAgent');
  console.log(JSON.stringify({version, hooks: Object.keys(hooks.hooks).length, modelCalls: calls, states: [...new Set(states)], result: 'passed'}, null, 2));
} finally {
  await daemon?.close();
  await new Promise(resolve => model.close(resolve));
  if (previous === undefined) delete process.env.ADP_CONFIG; else process.env.ADP_CONFIG = previous;
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
  await rm(dir, {recursive: true, force: true});
}
