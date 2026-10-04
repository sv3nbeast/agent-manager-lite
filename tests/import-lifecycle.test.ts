import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Store} from '../src/main/store'
import {AccountFiles} from '../src/main/accountFiles'
const raw=(name:string)=>JSON.stringify({account_name:name,openai_api_key:'fixture-'+name,api_model_catalog:['fixture-model']})
function fixture(t:{after(fn:()=>Promise<void>):void}){
 const root=mkdtempSync(join(tmpdir(),'cml-import-lifecycle-')),store=new Store(join(root,'vault'),{encrypt:v=>Buffer.from(v),decrypt:b=>b.toString()}),files=new AccountFiles(store),path=join(root,'accounts.json')
 writeFileSync(path,raw('selected-file'));t.after(async()=>{await files.stop();rmSync(root,{recursive:true,force:true})});return {store,files,path}
}
test('discarding an old import ticket leaves the new preview usable',t=>{
 const {store,files}=fixture(t),old=files.stage(raw('old')),fresh=files.stage(raw('fresh'));files.discard(old.ticket);assert.deepEqual(files.commit(fresh.ticket),{added:1,duplicates:0,skipped:0,accountIds:[store.read().accounts[0].id]});assert.equal(store.read().accounts[0].name,'fresh')
})
test('a late file dialog cannot replace a newer credential preview',async t=>{
 const {files,path,store}=fixture(t),operation=files.beginFileSelection(),fresh=files.stage(raw('fresh'));await assert.rejects(files.finishFileSelection(operation,path),/取消|替换/);files.commit(fresh.ticket);assert.equal(store.read().accounts[0].name,'fresh')
})
test('scoped file selection cancellation does not cancel another selection',async t=>{
 const {files,path}=fixture(t),selected=randomUUID(),operation=files.beginFileSelection(selected);files.cancelFileSelection(randomUUID());const staged=await files.finishFileSelection(operation,path);files.commit(staged.ticket)
})
test('closing a pending file selection prevents it from creating a preview',async t=>{
 const {files,path,store}=fixture(t),selected=randomUUID(),operation=files.beginFileSelection(selected);files.cancelFileSelection(selected);await assert.rejects(files.finishFileSelection(operation,path),/取消|替换/);assert.equal(store.read().accounts.length,0)
})
