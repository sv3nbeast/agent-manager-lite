import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {ClientSwitches} from '../../src/main/clientSwitch'
import {ClientConfigs,atomic} from '../../src/main/clientConfig'
import {Store} from '../../src/main/store'
import {TokenAuthority} from '../../src/main/tokens'

// This child only receives a temporary fixture vault and its random test key.
const [directory,targetId,accountId,at]=process.argv.slice(2)
const key=Buffer.from(process.env.CML_SWITCH_FIXTURE_KEY!,'base64')
const store=new Store(directory,{
  encrypt:value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data])},
  decrypt:value=>{const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(12,28));return Buffer.concat([c.update(value.subarray(28)),c.final()]).toString()}
})
let writes=0
const service=new ClientSwitches(store,new ClientConfigs(store),new TokenAuthority(store),undefined,undefined,(path,content)=>{
  atomic(path,content)
  if(++writes===Number(at))process.kill(process.pid,'SIGKILL')
})
service.apply({ticket:service.preview({targetId,accountId}).ticket,clientClosed:true})
throw new Error('Expected the fixture process to be killed during commit')
