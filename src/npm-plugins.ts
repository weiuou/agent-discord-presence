import {execFile} from 'node:child_process';
import {access, readFile, readdir, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {installPlugin, readPlugin, pruneMissingNpmPlugins, pluginStatePath, type PluginSource} from './agent-plugins.js';

const run = promisify(execFile);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export function parseNpmSource(spec: string): string {
  const name = spec.slice(4);
  if (!spec.startsWith('npm:') || !packageName.test(name) || name.length > 214 || name.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Use npm:PACKAGE or npm:@SCOPE/PACKAGE for a globally installed plugin');
  }
  return name;
}

export async function globalNpmRoot(): Promise<string | undefined> {
  if (process.env.ADP_NPM_ROOT) return resolve(process.env.ADP_NPM_ROOT);
  const executables = [process.env.ADP_NODE_HINT, process.execPath].filter((value): value is string => !!value && isAbsolute(value));
  const candidates = [process.env.npm_execpath,
    ...executables.flatMap(node => [join(dirname(node), 'node_modules/npm/bin/npm-cli.js'), join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')]),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js')] : [])];
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate || basename(candidate) !== 'npm-cli.js') continue;
    try {
      await access(candidate);
      const {stdout} = await run(process.execPath, [candidate, 'root', '--global'], {windowsHide:true,timeout:2000,maxBuffer:16384});
      const root = stdout.trim();
      if (isAbsolute(root)) return root;
    } catch { /* Try another Node/npm installation without opening a shell. */ }
  }
  const fallback = process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm/node_modules') : resolve(dirname(process.execPath), '../lib/node_modules');
  try {await access(fallback); return fallback;} catch {return;}
}

async function sourceAt(path: string, expectedName?: string): Promise<Extract<PluginSource, {type:'npm-global'}>> {
  if ((await stat(join(path, 'package.json'))).size > 131072) throw new Error('npm package metadata is too large');
  const raw = await readFile(join(path, 'package.json'));
  if (raw.length > 131072) throw new Error('npm package metadata is too large');
  const pkg = JSON.parse(raw.toString('utf8'));
  if (typeof pkg.name !== 'string' || !packageName.test(pkg.name) || (expectedName && pkg.name !== expectedName)) throw new Error('Invalid npm plugin package name');
  const manifest = readPlugin(path);
  if (manifest.version !== pkg.version) throw new Error('npm package and ADP manifest versions must match');
  return {type:'npm-global',spec:`npm:${pkg.name}`,package:pkg.name,version:pkg.version,path};
}
export async function resolveNpmPlugin(spec: string): Promise<{root:string; source:PluginSource}> {
  const name = parseNpmSource(spec), root = await globalNpmRoot();
  if (!root) throw new Error('Unable to find the global npm directory. Install npm or set ADP_NPM_ROOT.');
  const path = join(root, ...name.split('/'));
  try {return {root:path,source:await sourceAt(path,name)};}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Global npm plugin not found. Run npm install -g PACKAGE first.');
    throw error;
  }
}

const refreshes = new Map<string, {at:number; pending?:Promise<void>}>();
export async function refreshGlobalNpmPlugins(force = false): Promise<void> {
  if (process.env.ADP_NPM_AUTOLOAD === '0') return;
  const key = [pluginStatePath(),process.env.ADP_NPM_ROOT,process.env.npm_config_prefix,process.env.NPM_CONFIG_PREFIX].join('\n');
  const cached = refreshes.get(key);
  if (cached?.pending) return cached.pending;
  if (!force && cached && Date.now() - cached.at < 10_000) return;
  const entry: {at:number; pending?:Promise<void>} = {at:Date.now()};
  refreshes.set(key, entry);
  entry.pending = (async () => {
    const root = await globalNpmRoot(); if (!root) return;
    const paths: string[] = [];
    for (const dir of await readdir(root, {withFileTypes:true}).catch(() => [])) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
      if (dir.name.startsWith('@')) {
        for (const child of await readdir(join(root,dir.name), {withFileTypes:true}).catch(() => [])) {
          if (child.isDirectory() || child.isSymbolicLink()) paths.push(join(root,dir.name,child.name));
        }
      } else paths.push(join(root,dir.name));
      if (paths.length > 1024) break;
    }
    for (const path of paths.slice(0,1024)) {
      try {
        await access(join(path,'adp-plugin.json'));
        const source = await sourceAt(path);
        await installPlugin(path, {source,automatic:true});
      } catch { /* Ordinary npm packages and invalid plugins do not affect core Agents. */ }
    }
    await pruneMissingNpmPlugins();
  })().catch(() => {}).finally(() => {entry.at=Date.now(); entry.pending=undefined;});
  return entry.pending;
}
