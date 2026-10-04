import {readFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {syncJournalSchema,syncStage,publishSync} from '../../src/main/sessionSyncFiles'
const journal=syncJournalSchema.parse(JSON.parse(readFileSync(process.argv[2],'utf8'))),boundary=process.argv[3]
async function main(){
if(boundary==='renamed')renameSync(join(journal.root,journal.originals[0].relative),join(syncStage(journal),journal.originals[0].stage))
if(boundary==='published')await publishSync(journal,new AbortController().signal)
process.stdout.write('fixture-ready\n');setInterval(()=>{},1000)
}
void main().catch(error=>{console.error(error);process.exitCode=1})
