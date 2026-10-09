import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {codexBundledCli,codexDesktopExecutable} from '../src/main/codexPrograms'
import {sessionProgram,verifySessionProgram} from '../src/main/officialSessions'

function fixture(t:{after(fn:()=>void):void}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cml-codex-programs-'))),app=join(root,'Client.app')
  mkdirSync(app);t.after(()=>rmSync(root,{recursive:true,force:true}))
  const native=(path:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from('cffaedfe00000000','hex'),{mode:0o700});return path}
  return {root,app,native}
}

test('session metadata resolves current nested desktop CLI and preserves legacy bundle support',t=>{
  for(const path of [['codex'],['codex-cli','CodexCLI.app','Contents','MacOS','codex']]){
    const f=fixture(t),expected=f.native(join(f.app,'Contents','Resources',...path))
    assert.equal(codexBundledCli(f.app),expected)
    const program=sessionProgram({id:'fixture',name:'Client',path:f.app})
    assert.equal(program.path,expected);verifySessionProgram(program)
    writeFileSync(expected,Buffer.from('cffaedfe0000000000000000','hex'))
    assert.throws(()=>verifySessionProgram(program),/变化/)
  }
})

test('bundled CLI resolution rejects executable scripts, missing programs, and paths escaping the selected app',t=>{
  const f=fixture(t),path=join(f.app,'Contents','Resources','codex')
  assert.throws(()=>codexBundledCli(f.app),/缺少/)
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'#!/bin/sh\nexit 0\n',{mode:0o700})
  assert.throws(()=>codexBundledCli(f.app),/原生/)
  rmSync(path);const outside=f.native(join(f.root,'outside-codex'));symlinkSync(outside,path)
  assert.throws(()=>codexBundledCli(f.app),/目录之外/)
  rmSync(path);const nested=f.native(join(f.app,'Contents','Resources','codex-cli','CodexCLI.app','Contents','MacOS','codex'))
  chmodSync(nested,0o600);assert.throws(()=>codexBundledCli(f.app),/可执行/)
})

test('Codex and current ChatGPT desktop entries retain canonical executable and bundle checks',t=>{
  for(const name of ['Codex','ChatGPT']){
    const f=fixture(t),path=f.native(join(f.app,'Contents','MacOS',name))
    assert.equal(codexDesktopExecutable(f.app),path)
    const alias=join(f.root,'Alias.app');symlinkSync(f.app,alias)
    assert.throws(()=>codexDesktopExecutable(alias),/变化/)
    chmodSync(path,0o600);assert.throws(()=>codexDesktopExecutable(f.app),/可执行/)
    rmSync(path);symlinkSync(f.native(join(f.root,'outside')),path)
    assert.throws(()=>codexDesktopExecutable(f.app),/可执行/)
  }
})
