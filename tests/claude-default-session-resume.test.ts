import test from 'node:test'
import assert from 'node:assert/strict'
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,realpathSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ClaudeDefaultSessionResume,defaultClaudeResumeScript} from '../src/main/claudeDefaultSessionResume'
import {SessionCatalog} from '../src/main/sessions'
import {Store} from '../src/main/store'

test('default Claude continuation opens a revalidated fork using only the local default profile',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-default-claude-resume-'))),home=join(root,'home'),config=join(home,'.claude'),project=join(root,'project'),transcripts=join(config,'projects','one')
  mkdirSync(transcripts,{recursive:true});mkdirSync(project)
  const cli=join(root,'official-claude-fixture');writeFileSync(cli,'synthetic executable');chmodSync(cli,0o700)
  const id=randomUUID(),path=join(transcripts,id+'.jsonl'),body=JSON.stringify({type:'user',sessionId:id,cwd:project,message:{content:'Synthetic only'}})+'\n'
  writeFileSync(path,body)
  const store=new Store(join(root,'manager'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),before=store.read(),catalog=new SessionCatalog(store,undefined,{defaultClaudeDirectory:config})
  const page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'}),source=page.sources?.find(value=>value.role==='default'&&value.clientType==='claude_code'),row=page.items.find(value=>value.locations.some(location=>location.targetId===source?.id)),selection={snapshotId:page.snapshotId,sessionId:row!.id,targetId:source!.id},opened:string[]=[]
  const launcher=new ClaudeDefaultSessionResume(catalog,{home,cliPath:cli,verifyCli:async()=>{},open:async script=>opened.push(script)})
  t.after(()=>{catalog.stop();rmSync(root,{recursive:true,force:true})})
  const preview=await launcher.preview(selection)
  assert.equal(preview.sessionId,id);assert.equal(preview.forkSession,true);assert.equal(preview.cliApplication,cli)
  assert.deepEqual(store.read(),before)
  assert.deepEqual(await launcher.start(preview.ticket),{opened:true})
  const script=readFileSync(opened[0],'utf8')
  assert.match(script,/--fork-session --resume/);assert.match(script,/shasum -a 256/g);assert.match(script,/codesign --verify/);assert.match(script,/Identifier=com\.anthropic\.claude-code/);assert.match(script,/find .* -name/);assert.match(script,/trap .* EXIT/)
  assert.doesNotMatch(script,/CLAUDE_CONFIG_DIR=|ANTHROPIC_API_KEY=|ANTHROPIC_AUTH_TOKEN=/)
  assert.equal(readFileSync(path,'utf8'),body);assert.deepEqual(store.read(),before)
})

test('default fork tickets are single use and terminal failures clean the temporary launcher',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aml-default-claude-resume-'))),home=join(root,'home'),config=join(home,'.claude'),project=join(root,'project'),transcripts=join(config,'projects','one')
  mkdirSync(transcripts,{recursive:true});mkdirSync(project)
  const cli=join(root,'official-claude-fixture');writeFileSync(cli,'synthetic executable');chmodSync(cli,0o700)
  const id=randomUUID(),path=join(transcripts,id+'.jsonl'),body=JSON.stringify({type:'user',sessionId:id,cwd:project,message:{content:'Fixture'}})+'\n';writeFileSync(path,body)
  const catalog=new SessionCatalog(new Store(join(root,'manager'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()}),undefined,{defaultClaudeDirectory:config})
  t.after(()=>{catalog.stop();rmSync(root,{recursive:true,force:true})})
  const page=await catalog.scan({runId:randomUUID(),clientType:'claude_code'}),source=page.sources?.find(value=>value.role==='default'&&value.clientType==='claude_code'),row=page.items.find(value=>value.locations.some(location=>location.targetId===source?.id)),selection={snapshotId:page.snapshotId,sessionId:row!.id,targetId:source!.id}
  let attemptedScript='';const launcher=new ClaudeDefaultSessionResume(catalog,{home,cliPath:cli,verifyCli:async()=>{},open:async script=>{attemptedScript=script;throw new Error('Terminal unavailable')}}),preview=await launcher.preview(selection)
  await assert.rejects(launcher.start(preview.ticket),/Terminal unavailable/)
  await assert.rejects(launcher.start(preview.ticket),/预览已过期/)
  assert.ok(attemptedScript);assert.equal(existsSync(attemptedScript),false);assert.equal(existsSync(dirname(attemptedScript)),false)
})

test('default fork script checks session and path identity before continuing',()=>{
  const script=defaultClaudeResumeScript({scriptPath:'/tmp/ticket/run.command',directory:'/tmp/ticket',homeDirectory:'/fixture/home',configCanonicalPath:'/fixture/home/.claude',configDevice:1,configInode:2,projectsDirectory:'/fixture/home/.claude/projects',projectsDevice:1,projectsInode:3,projectDirectory:'/fixture/home/.claude/projects/project',projectDevice:1,projectInode:4,executable:'/fixture/home/.local/bin/claude',executableDevice:1,executableInode:5,executableSize:4096,executableSha256:'b'.repeat(64),cwd:'/tmp/project',cwdCanonicalPath:'/private/tmp/project',cwdDevice:1,cwdInode:6,sessionPath:'/fixture/home/.claude/projects/project/session.jsonl',sessionDevice:1,sessionInode:7,sessionSize:100,sessionSha256:'a'.repeat(64),sessionId:'session-id'})
  assert.match(script,/shasum -a 256/);assert.match(script,/--fork-session --resume 'session-id'/);assert.match(script,/ssh-\*.*-prune/);assert.match(script,/matches.*= 1/);assert.match(script,/grep -Fq "Authority=Developer ID Application: Anthropic PBC"/)
  assert.doesNotMatch(script,/ANTHROPIC_API_KEY=.*export/)
})
