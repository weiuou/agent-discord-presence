import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseNpmSource,refreshGlobalNpmPlugins,resolveNpmPlugin} from '../dist/npm-plugins.js';
import {getPlugin,listPlugins,changePlugin,installPlugin} from '../dist/agent-plugins.js';
import {installPluginSource} from '../dist/plugin-install.js';

test('npm sources accept package names and scopes without paths or command fragments',()=>{
  assert.equal(parseNpmSource('npm:@example/agent-plugin'),'@example/agent-plugin');
  assert.equal(parseNpmSource('npm:agent-plugin'),'agent-plugin');
  for(const spec of ['npm:../plugin','npm:@scope/../plugin','npm:pkg@latest','npm:pkg;echo','npm:https://example.com/plugin','npm:']) assert.throws(()=>parseNpmSource(spec));
});

test('global npm discovery handles upgrades, user choices and uninstall/reinstall without executing package code',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'adp-npm-'));
  const keys=['ADP_CONFIG','ADP_NPM_ROOT','ADP_NPM_AUTOLOAD'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.ADP_CONFIG=join(dir,'config.json');process.env.ADP_NPM_ROOT=join(dir,'global');process.env.ADP_NPM_AUTOLOAD='1';
  t.after(async()=>{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});});
  const source=join(process.env.ADP_NPM_ROOT,'@example','orbit');
  async function packageVersion(version){
    await mkdir(source,{recursive:true});
    await writeFile(join(source,'package.json'),JSON.stringify({name:'@example/orbit',version}));
    await writeFile(join(source,'adp-plugin.json'),JSON.stringify({apiVersion:1,id:'orbit',name:'Orbit Agent',version,extension:'adapter.mjs'}));
    await writeFile(join(source,'adapter.mjs'),'throw new Error("Discovery must not execute this module")');
  }
  await packageVersion('1.0.0');
  const ordinary=join(process.env.ADP_NPM_ROOT,'ordinary');await mkdir(ordinary);await writeFile(join(ordinary,'package.json'),'{"name":"ordinary","version":"1.0.0"}');
  await refreshGlobalNpmPlugins(true);
  assert.deepEqual(listPlugins().map(plugin=>plugin.id),['orbit']);
  let plugin=getPlugin('orbit');assert.equal(plugin.enabled,true);assert.notEqual(plugin.root,source);
  assert.equal(plugin.source.package,'@example/orbit');
  assert.ok(JSON.parse(await readFile(join(plugin.root,'.adp-runtime.json'),'utf8')).sdk);
  await changePlugin('orbit','disable');await refreshGlobalNpmPlugins(true);assert.equal(getPlugin('orbit').enabled,false);
  await packageVersion('1.1.0');await refreshGlobalNpmPlugins(true);
  assert.equal(getPlugin('orbit').manifest.version,'1.1.0');assert.equal(getPlugin('orbit').enabled,false);
  await changePlugin('orbit','enable');await changePlugin('orbit','remove');await refreshGlobalNpmPlugins(true);assert.equal(getPlugin('orbit'),undefined);
  assert.equal((await resolveNpmPlugin('npm:@example/orbit')).root,source);
  await installPluginSource('npm:@example/orbit');assert.equal(getPlugin('orbit').enabled,true);
  await rm(source,{recursive:true});await refreshGlobalNpmPlugins(true);assert.equal(getPlugin('orbit'),undefined);
  await packageVersion('1.1.0');await refreshGlobalNpmPlugins(true);assert.equal(getPlugin('orbit').enabled,true);
  // An explicit local package takes precedence over future automatic npm scans.
  await changePlugin('orbit','remove');await installPlugin(source);
  const manual=getPlugin('orbit').root;
  await packageVersion('1.2.0');await refreshGlobalNpmPlugins(true);assert.equal(getPlugin('orbit').root,manual);
});
