import test from 'node:test'
import assert from 'node:assert/strict'
import {codexDesktopStartupImports} from '../src/main/codexDesktopResources'

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
