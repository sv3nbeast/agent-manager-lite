// Defaults to a read-only preview. Run --apply only from an independent
// terminal after closing the target instance. Never modifies SQLite.
import {parseArgs} from 'node:util'
import {prepareRolloutProviderRecovery,applyRolloutProviderRecovery} from '../src/main/codexRolloutRecovery'

async function main(){
  const {values}=parseArgs({options:{original:{type:'string'},rollout:{type:'string'},apply:{type:'boolean',default:false}}})
  if(!values.original||!values.rollout)throw new Error('Usage: tsx scripts/repair-codex-rollout-provider.ts --original /original/rollout.jsonl --rollout /instance/rollout.jsonl[.zst] [--apply]')
  const plan=await prepareRolloutProviderRecovery(values.original,values.rollout)
  console.log(JSON.stringify({mode:values.apply?'apply':'preview',...plan.summary},null,2))
  if(values.apply)console.log(JSON.stringify(await applyRolloutProviderRecovery(plan)))
}
void main().catch(error=>{console.error(error.message);process.exitCode=1})
