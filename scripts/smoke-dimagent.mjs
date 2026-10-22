// Optional real-host check: node scripts/smoke-dimagent.mjs /absolute/path/to/dim
// Uses a temporary DimAgent home, a local fake model, and a fake Discord transport.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startDaemon} from '../dist/daemon.js';
import {ipcPath} from '../test/ipc-path.js';

const command = process.argv[2];
const external = process.argv.includes('--external');
if (!command) throw new Error('Pass the absolute path to the DimAgent executable (dim or dimcode.exe).');
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'adp-dimagent-smoke-'));
const previous = process.env.ADP_CONFIG;
const previousCommand = process.env.ADP_DIMAGENT_COMMAND; const previousHome = process.env.DIMCODE_HOME;
process.env.ADP_DIMAGENT_COMMAND = command; process.env.DIMCODE_HOME = join(dir, 'home');
process.env.ADP_CONFIG = join(dir, 'adp.json');
await writeFile(process.env.ADP_CONFIG, '{"enabled":true}');
const states = [];
let calls = 0;
let summaries = 0;
const model = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    calls++;
    const input = JSON.parse(body);
    assert.equal(input.model, 'adp-test');
    const summary = input.response_format?.type === 'json_object' || JSON.stringify(input).includes('Return only JSON matching this schema');
    if (summary) {
      summaries++;
      assert.ok(!input.tools || input.tools.length === 0, 'Summary worker must have no tools');
      assert.ok(JSON.stringify(input).includes('Local presence smoke test completed.'));
      assert.ok(!JSON.stringify(input).includes('PRIVATE_USER_SENTINEL'), 'User prompt must not reach the summary worker');
    }
    const content = summary ? JSON.stringify({topic: 'Testing automatic DimAgent summaries', subtitle: 'Completed reply only'}) : 'Local presence smoke test completed.';
    if (input.response_format?.type === 'json_object') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}}]})); return;
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'adp-smoke', object: 'chat.completion.chunk',
      created: 1, model: 'adp-test', choices: [{index: 0, delta, finish_reason}]})}\n\n`);
    chunk({role: 'assistant', content});
    chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
});
let daemon;
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  if (external) await writeFile(process.env.ADP_CONFIG, JSON.stringify({agents: {dimagent: {
    service: 'openai-compatible', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: '',
  }}}));
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
  await run(command, ['exec', '--provider', 'adp-test', '--model', 'adp-test', '--policy', 'read-only', '--tools', 'read', 'PRIVATE_USER_SENTINEL: Run the local presence test.']);
  assert.ok(calls > 0, 'Host must call the local model');
  assert.ok(states.includes('Working'), 'UserPromptSubmit must reach ADP');
  assert.ok(states.includes('Ready for a prompt'), 'SessionStart/Stop must reach ADP');
  const session = [...daemon.store.sessions.values()].find(s => s.agent === 'dimagent');
  assert.equal(session?.state, 'idle');
  const key = `dimagent:${session.sessionId}`;
  const deadline = Date.now() + 30_000;
  while (daemon.store.sessions.get(key)?.summary?.topic !== 'Testing automatic DimAgent summaries' && Date.now() < deadline) await delay(50);
  assert.equal(daemon.store.sessions.get(key)?.summary?.topic, 'Testing automatic DimAgent summaries', JSON.stringify(daemon.store.sessions.get(key)));
  await run(process.execPath, [join(root, 'dist/cli.js'), 'summary', `dimagent:${session.sessionId}`, 'Testing DimAgent']);
  assert.equal(daemon.store.sessions.get(key)?.summary?.topic, 'Testing DimAgent');
  console.log(JSON.stringify({version, service: external ? 'openai-compatible' : 'session', hooks: Object.keys(hooks.hooks).length, modelCalls: calls, automaticSummaries: summaries, states: [...new Set(states)], result: 'passed'}, null, 2));
} finally {
  await daemon?.close();
  await new Promise(resolve => model.close(resolve));
  if (previous === undefined) delete process.env.ADP_CONFIG; else process.env.ADP_CONFIG = previous;
  if (previousCommand === undefined) delete process.env.ADP_DIMAGENT_COMMAND; else process.env.ADP_DIMAGENT_COMMAND = previousCommand;
  if (previousHome === undefined) delete process.env.DIMCODE_HOME; else process.env.DIMCODE_HOME = previousHome;
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
  await rm(dir, {recursive: true, force: true});
}
