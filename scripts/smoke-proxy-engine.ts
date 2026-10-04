// Explicit engine integration: official pinned binary, disposable data directory,
// version only; no proxy startup, account, keychain or existing app configuration.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {ProxyEngine} from '../src/main/proxyEngine'
async function main(){
const index=process.argv.indexOf('--archive'),archive=index>=0?resolve(process.argv[index+1]):undefined
if(!archive&&!process.argv.includes('--download'))throw new Error('Choose --archive <official package> or --download explicitly')
const directory=mkdtempSync(join(tmpdir(),'cml-engine-integration-')),engine=new ProxyEngine(directory)
try{
  assert.equal((await engine.status()).installedVersion,null)
  engine.begin(archive)
  const result=await engine.wait();assert.equal(result.phase,'completed',JSON.stringify(result))
  await engine.preflight();assert.equal(existsSync(join(directory,'state.vault')),false)
  console.log(JSON.stringify({result:'passed',mode:archive?'import':'download',version:result.version,asset:result.assetName,bytes:result.receivedBytes,checks:'official archive SHA256, streamed extraction, real version subprocess, durable install, preflight hash/version, no vault or network tunnel'},null,2))
}finally{await engine.stop();rmSync(directory,{recursive:true,force:true})}
}
void main().catch(error=>{console.error(error);process.exitCode=1})
