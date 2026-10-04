import {readFileSync} from 'node:fs'
import {sessionJournalSchema,publishSessionTransfer} from '../../src/main/sessionTransferFiles'

const journal=sessionJournalSchema.parse(JSON.parse(readFileSync(process.argv[2],'utf8')))
if(process.argv[3]==='published')publishSessionTransfer(journal)
process.stdout.write('session-transfer-crash-fixture-ready\n')
setInterval(()=>{},1000)
