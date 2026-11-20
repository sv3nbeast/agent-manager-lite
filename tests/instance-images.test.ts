import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { Store } from '../src/main/store'
import { InstanceImages, relocateCopiedImagesPlugin } from '../src/main/instanceImages'
import { createAPIAccount } from '../src/main/accounts'
import { TomlDocument } from '../src/main/tomlPatch'
import type { InstanceProfile } from '../src/shared/instances'

function fixture(t: {after(fn: () => void | Promise<void>): void}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aml-images-')))
  const store = new Store(root, {encrypt: text => Buffer.from(text), decrypt: buffer => buffer.toString()})
  const account = createAPIAccount({name:'Fixture',apiKey:'upstream-fixture',baseUrl:'https://fixture.invalid/v1',models:['text-model','future/image-v2'],wireApi:'responses'})
  store.transaction(state => { state.accounts.push(account) })
  function add() {
    const profile: InstanceProfile = {id:randomUUID(),name:'Fixture',applicationId:'fixture',accountId:account.id,clientType:'codex',connectionMode:'local_api',model:'text-model',defaultTier:'inherit',extraArgs:[],revision:0,createdAt:Date.now()}
    store.transaction(state => { state.instances = [...state.instances ?? [], profile] })
    const home = join(root,'instances',profile.id,'home')
    mkdirSync(home,{recursive:true})
    writeFileSync(join(home,'config.toml'),'# retain this comment\nmodel = "text-model"\n[mcp_servers.other]\ncommand = "other-fixture"\n')
    return {profile,home,config:join(home,'tools','sub2api-images','config.json')}
  }
  const images = new InstanceImages(store,resolve('resources/bin/images-mcp'))
  t.after(() => rmSync(root,{recursive:true,force:true}))
  return {root,store,add,images}
}

test('images plugin uses per-instance gateway credentials, preserves TOML and clears stopped credentials', t => {
  const f=fixture(t),a=f.add(),b=f.add()
  f.images.prepare(a.profile,{port:12001,key:'instance-a'})
  f.images.prepare(b.profile,{port:12002,key:'instance-b'})
  const read=(file:string)=>JSON.parse(readFileSync(file,'utf8'))
  assert.equal(f.images.notice(a.profile.id),undefined)
  assert.equal(read(a.config).api_key,'instance-a')
  assert.equal(read(b.config).api_key,'instance-b')
  assert.equal(read(a.config).model,'gpt-image-2.6-sunburst')
  assert.equal(statSync(a.config).mode&0o777,0o600)
  for(const item of [a,b]) {
    const raw=readFileSync(join(item.home,'config.toml'),'utf8'),doc=new TomlDocument(raw)
    assert.equal(doc.scalar(['model']),'text-model');assert.ok(raw.includes('# retain this comment'))
    assert.equal(doc.scalar(['mcp_servers','other','command']),'other-fixture')
    assert.equal(doc.scalar(['mcp_servers','sub2api_images','command']),join(f.root,'tools','images-mcp','images-mcp'))
    assert.ok(!raw.includes('instance-a')&&!raw.includes('instance-b'),'credentials never enter MCP command arguments')
  }
  f.store.transaction(state=>{state.settings.imageGenerationModel='future/image-v2'})
  assert.equal(f.images.sync(),0)
  assert.equal(read(a.config).model,'future/image-v2');assert.equal(read(b.config).model,'future/image-v2')
  f.images.stop(a.profile)
  assert.equal(read(a.config).active,false);assert.equal(read(a.config).api_key,'');assert.equal(read(b.config).api_key,'instance-b')
  f.images.prepare(a.profile,{port:12003,key:'rotated-a'})
  assert.equal(read(a.config).api_key,'rotated-a')
  f.images.prepare({...a.profile,connectionMode:'native'})
  assert.equal(read(a.config).active,false,'switching to native must not retain old API credentials')
})

test('native and external/Claude homes are not given a new image tool', t => {
  const f=fixture(t),a=f.add(),b=f.add(),c=f.add()
  f.images.prepare({...a.profile,connectionMode:'native'})
  f.images.prepare({...b.profile,clientType:'claude_code'},{port:1234,key:'unused'})
  f.images.prepare({...c.profile,externalHome:{directory:c.home,device:0,inode:0}},{port:1234,key:'unused'})
  for(const value of [a,b,c])assert.equal(existsSync(value.config),false)
})

test('full profile copy removes source credentials and rewrites only owned plugin references', t => {
  const f=fixture(t),a=f.add(),b=f.add()
  f.images.prepare(a.profile,{port:11111,key:'source-private-key'})
  const raw=readFileSync(join(a.home,'config.toml'),'utf8')
  mkdirSync(join(b.home,'tools','sub2api-images'),{recursive:true})
  writeFileSync(b.config,readFileSync(a.config),{mode:0o600})
  const projected=relocateCopiedImagesPlugin(raw,a.home,b.home,b.home)
  writeFileSync(join(b.home,'config.toml'),projected)
  const copied=JSON.parse(readFileSync(b.config,'utf8'))
  assert.equal(copied.api_key,'');assert.equal(copied.base_url,'');assert.equal(copied.active,false)
  assert.equal(copied.output_dir,join(b.home,'generated_images','images-api'))
  assert.ok(!projected.includes(a.home))
  f.images.prepare(b.profile,{port:22222,key:'target-private-key'})
  assert.equal(JSON.parse(readFileSync(b.config,'utf8')).api_key,'target-private-key')
  assert.equal(JSON.parse(readFileSync(a.config,'utf8')).api_key,'source-private-key')
})

test('dotted-key legacy registration upgrades while keeping endpoint, secret and disabled state', t => {
  const f=fixture(t),a=f.add(),folder=join(a.home,'tools','sub2api-images'),script=join(folder,'codex_images_mcp.py')
  mkdirSync(folder,{recursive:true})
  const binary=join(f.root,'tools','images-mcp','images-mcp')
  const bridge=`# Agent Manager Lite Images API compatibility launcher\nimport argparse, os\np = argparse.ArgumentParser()\np.add_argument('--config', required=True)\na = p.parse_args()\nb = ${JSON.stringify(binary)}\nos.execv(b, [b, '--config', a.config])\n`
  writeFileSync(script,bridge)
  writeFileSync(a.config,JSON.stringify({base_url:'https://another-compatible.invalid/v1',api_key:'legacy-only',model:'old-image',output_dir:join(a.home,'images'),http_timeout_seconds:180,tool_timeout_seconds:240,custom:'preserved'}),{mode:0o600})
  const original=`# keep\nmcp_servers.sub2api_images.enabled = false\nmcp_servers.sub2api_images.command = '/usr/bin/python3'\nmcp_servers.sub2api_images.args = [${JSON.stringify(script)}, '--config', ${JSON.stringify(a.config)}]\nmodel = 'text-model'\n`
  writeFileSync(join(a.home,'config.toml'),original)
  assert.equal(f.images.sync(),0)
  const data=JSON.parse(readFileSync(a.config,'utf8'))
  assert.equal(data.model,'gpt-image-2.6-sunburst');assert.equal(data.base_url,'https://another-compatible.invalid/v1');assert.equal(data.api_key,'legacy-only');assert.equal(data.custom,'preserved')
  assert.equal(new TomlDocument(readFileSync(join(a.home,'config.toml'),'utf8')).scalar(['mcp_servers','sub2api_images','enabled']),false)
  f.images.prepare(a.profile,{port:10001,key:'do-not-replace-legacy-connection'})
  assert.equal(JSON.parse(readFileSync(a.config,'utf8')).api_key,'legacy-only')
})

test('custom same-name plugins, unsafe files and symlinked homes are preserved with a notice', t => {
  const f=fixture(t),a=f.add(),b=f.add(),c=f.add()
  const custom='[mcp_servers.sub2api_images]\ncommand="my-custom-tool"\nargs=[]\n'
  writeFileSync(join(a.home,'config.toml'),custom)
  f.images.prepare(a.profile,{port:1234,key:'unused'})
  assert.equal(readFileSync(join(a.home,'config.toml'),'utf8'),custom);assert.match(f.images.notice(a.profile.id)!,/自定义/)
  f.images.prepare(b.profile,{port:1234,key:'secret'})
  const previous=readFileSync(b.config,'utf8');chmodSync(b.config,0o644)
  assert.equal(f.images.sync(),1);assert.equal(readFileSync(b.config,'utf8'),previous)
  rmSync(c.home,{recursive:true});symlinkSync(a.home,c.home,'dir')
  f.images.prepare(c.profile,{port:1234,key:'unused'})
  assert.match(f.images.notice(c.profile.id)!,/未能接入/);assert.equal(readFileSync(join(a.home,'config.toml'),'utf8'),custom)
})

test('manager save reaches a live MCP process on its very next request', async t => {
  const f=fixture(t),a=f.add(),models:string[]=[]
  const upstream=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>{raw+=chunk});req.on('end',()=>{
      assert.equal(req.url,'/v1/images/generations');assert.equal(req.headers.authorization,'Bearer isolated-key')
      models.push(JSON.parse(raw).model)
      res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='}]}))
    })
  })
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>((resolve,reject)=>upstream.close(error=>error?reject(error):resolve())))
  const port=(upstream.address() as {port:number}).port
  f.images.prepare(a.profile,{port,key:'isolated-key'})
  const child=spawn(join(f.root,'tools','images-mcp','images-mcp'),['--config',a.config],{stdio:['pipe','pipe','pipe']})
  t.after(()=>{child.kill()})
  const lines=createInterface({input:child.stdout}),pending=new Map<number,(value:any)=>void>()
  lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value)})
  let id=0
  const call=()=>new Promise<any>((resolve,reject)=>{
    const current=++id,timer=setTimeout(()=>reject(new Error('MCP timeout')),5000)
    pending.set(current,value=>{clearTimeout(timer);pending.delete(current);resolve(value)})
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:current,method:'tools/call',params:{name:'imagegen',arguments:{prompt:'synthetic test'}}})+'\n')
  })
  assert.equal((await call()).result.isError,undefined)
  f.store.transaction(state=>{state.settings.imageGenerationModel='future/image-v2'})
  assert.equal(f.images.sync(),0)
  assert.equal((await call()).result.isError,undefined)
  assert.deepEqual(models,['gpt-image-2.6-sunburst','future/image-v2'])
  child.stdin.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()))
})
