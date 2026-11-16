import test from 'node:test'
import assert from 'node:assert/strict'
import {codexDesktopAppProtocolCount,codexDesktopStartupImports} from '../src/main/codexDesktopResources'

test('page protocol detection excludes only a proven isolated session handler',()=>{
  const page='electron.protocol.handle("app",request=>servePage(request));'
  const isolated='class Networking { create(){ const partition=electron.session.fromPartition("networking"); partition.protocol.handle("app",()=>new Response("network")); return partition; } }'
  assert.equal(codexDesktopAppProtocolCount(page),1)
  assert.equal(codexDesktopAppProtocolCount(isolated),0)
  assert.equal(codexDesktopAppProtocolCount(page+isolated),1)
  assert.equal(codexDesktopAppProtocolCount(page+page),2)
  assert.equal(codexDesktopAppProtocolCount(isolated.replace('electron.session.fromPartition("networking")','electron.session.defaultSession')),1)
  assert.equal(codexDesktopAppProtocolCount(isolated.replace('const partition','let partition').replace('partition.protocol','partition=electron.session.defaultSession;partition.protocol')),1)
  assert.equal(codexDesktopAppProtocolCount('unknown.protocol.handle(`app`,()=>null)'),1)
})

const bundled='loader.u=id=>"entry-"+id+"-"+({7:"first",9:"second"})[id]+".js";loader.f.require=id=>require("./"+loader.u(id));'

test('startup dependencies support both CommonJS and static bundled chunk maps',()=>{
  assert.deepEqual(codexDesktopStartupImports('require("electron");require("./startup-next.js");'),['./startup-next.js'])
  assert.deepEqual(codexDesktopStartupImports(bundled),['./entry-7-first.js','./entry-9-second.js'])
  assert.deepEqual(codexDesktopStartupImports(bundled.replaceAll('loader','renamed').replace('id=>','function(id){return ').replace(';loader.f','};loader.f').replace(';renamed.f','};renamed.f')),['./entry-7-first.js','./entry-9-second.js'])
})

test('chunk discovery refuses dynamic execution, traversal and ambiguous loaders',()=>{
  for(const source of [
    bundled.replace('"entry-"','globalThis.untrusted()'),
    bundled.replace('"entry-"','"../entry-"'),
    bundled.replace('"first"','"../first"'),
    bundled.replace('loader.u(id)','another.u(id)'),
    bundled+bundled.replaceAll('loader','other'),
    'require("../outside.js")'
  ])assert.throws(()=>codexDesktopStartupImports(source))
  assert.throws(()=>codexDesktopStartupImports(bundled.replace('7:"first",9:"second"',Array.from({length:65},(_,i)=>`${i}:"hash"`).join(','))))
})
