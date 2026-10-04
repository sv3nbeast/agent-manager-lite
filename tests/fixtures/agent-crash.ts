import { join, resolve } from 'node:path'
import { Store } from '../../src/main/store'
import { Gateway } from '../../src/main/gateway'
import { AgentIdentityService } from '../../src/main/agentIdentity'
import { settingsSchema } from '../../src/shared/types'

async function main() {
  const root = process.argv[2]
  const store = new Store(join(root,'vault'),{encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()})
  const service = new AgentIdentityService(store, async()=>{throw new Error('offline fixture')})
  const account = store.read().accounts[0]
  const gateway = new Gateway(resolve('resources/bin/codex-proxy'),join(root,'runtime'),()=>{},(id,identity,expected)=>service.adopt(id,identity,expected))
  await gateway.start({id:account.id,account,apiKey:'fixture-only',port:0},settingsSchema.parse({}))
  process.stdout.write(JSON.stringify({directory:gateway.runtimeDirectory()})+'\n')
  setInterval(()=>{},1000)
}
void main().catch(()=>process.exit(1))
