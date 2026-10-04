import {rmSync,lstatSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {deleteTrashOriginals,restoreTrashBatch,loadTrashJournal,type TrashRuntime} from '../../src/main/sessionTrashFiles'
const folder=process.argv[2],phase=process.argv[3],journal=loadTrashJournal(folder),path=realpathSync(process.execPath),stat=lstatSync(path),program={path,device:stat.dev,inode:stat.ino,size:stat.size,mtime:stat.mtimeMs}
const gate=()=>new Promise<never>(()=>{process.stdout.write('fixture-ready\n');setInterval(()=>{},1000)})
const runtime:TrashRuntime={plan:async()=>journal.allIds.map(id=>({id,descendant:!journal.selectedIds.includes(id)})),verify:async()=>{},remove:async()=>{rmSync(join(journal.root,journal.files[0].relative));return gate()},rebuild:gate}
void (phase==='deleting'?deleteTrashOriginals(folder,program,new AbortController().signal,runtime):restoreTrashBatch(folder,program,new AbortController().signal,runtime)).catch(error=>{console.error(error);process.exitCode=1})
