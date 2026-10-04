import {readFileSync} from 'node:fs'
import {importTrashBackup} from '../../src/main/sessionTrashFiles'
void importTrashBackup(process.argv[2],JSON.parse(readFileSync(process.argv[3],'utf8')),new AbortController().signal,bytes=>{if(bytes>=512*1024)process.kill(process.pid,'SIGKILL')})
