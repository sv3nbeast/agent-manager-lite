// Isolated crash fixture: never packaged, requires the parent's random vault key.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {Store} from '../../src/main/store'
import {TokenAuthority} from '../../src/main/tokens'
import {Instances} from '../../src/main/instances'
import {NativeInstanceAccounts} from '../../src/main/nativeInstanceAccounts'
const [directory,id]=process.argv.slice(2),key=Buffer.from(process.env.CML_NATIVE_INSTANCE_FIXTURE_KEY??'','base64')
if(key.length!==32||!directory||!id)throw new Error('Missing fixture data')
const store=new Store(directory,{encrypt:raw=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(raw),c.final(),c.getAuthTag()])},decrypt:raw=>{const c=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));c.setAuthTag(raw.subarray(-16));return Buffer.concat([c.update(raw.subarray(12,-16)),c.final()]).toString()}})
const tokens=new TokenAuthority(store,async()=>{throw new Error('Fixture forbids network')})
const instances=new Instances(store,()=>{throw new Error('No fixture gateway')},id=>tokens.ensure(id),{
  find:async()=>undefined,stop:async()=>{},focus:async()=>{},launch:async()=>{process.kill(process.pid,'SIGKILL');throw new Error('Unreachable')}
},new NativeInstanceAccounts(store,tokens))
instances.start(instances.preview({id,revision:store.read().instances!.find(value=>value.id===id)!.revision}).ticket)
void instances.settled(id).then(()=>{throw new Error('Fixture did not reach launch')})
