import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {zstdCompressSync} from 'node:zlib'
import {readRolloutHeader} from '../src/main/codexRolloutMetadata'

test('bounded header reads retain the caller descriptor for plain and compressed rollouts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'aml-rollout-header-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const header=JSON.stringify({type:'session_meta',ordinal:0,payload:{id:'fixture',instructions:'x'.repeat(80_000)}})+'\r\n'
  for(const compressed of [false,true]){
    const raw=Buffer.from(header+'body'.repeat(100_000)),content=compressed?zstdCompressSync(raw):raw,path=join(root,compressed?'compressed':'plain')
    await writeFile(path,content);const file=await open(path,'r')
    try{
      const result=await readRolloutHeader(file,content.length,compressed,new AbortController().signal)
      assert.equal(result.event.payload.id,'fixture');assert.deepEqual(result.bytes,Buffer.from(header))
      assert.equal((await file.stat()).size,content.length)
    }finally{await file.close()}
  }
})

test('corrupt, oversized and cancelled metadata reads fail without closing the caller descriptor',async t=>{
  const root=await mkdtemp(join(tmpdir(),'aml-rollout-header-'));t.after(()=>rm(root,{recursive:true,force:true}))
  for(const kind of ['corrupt','oversized','cancelled']){
    const content=kind==='corrupt'?Buffer.from('not zstandard'):zstdCompressSync(Buffer.from(JSON.stringify({type:'session_meta',payload:{id:'fixture',text:'x'.repeat(5*1024*1024)}})+'\n'))
    const path=join(root,kind);await writeFile(path,content);const file=await open(path,'r'),controller=new AbortController()
    if(kind==='cancelled')controller.abort()
    try{
      await assert.rejects(readRolloutHeader(file,content.length,true,controller.signal),kind==='oversized'?/4 MiB/:undefined)
      assert.equal((await file.stat()).size,content.length)
    }finally{await file.close()}
  }
})
