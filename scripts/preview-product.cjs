// Disposable desktop preview. Never opens the real vault or OS Keychain.
const {app,safeStorage}=require('electron')
const {mkdtempSync,rmSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const {createServer}=require('node:http')
const directory=mkdtempSync(join(tmpdir(),'codex-manager-ui-preview-'))
process.env.CML_TEST_DATA_DIR=directory
require('./test-vault.cjs').installTestVault(safeStorage)
app.setLoginItemSettings=()=>{}
const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'gpt-demo-fast'},{id:'gpt-demo-standard'},{id:'gpt-demo-reasoning'}]}))
  else {res.statusCode=404;res.end('{}')}
})
server.listen(0,'127.0.0.1',()=>console.log(`Preview model endpoint: http://127.0.0.1:${server.address().port}/v1 (test key: fixture-preview-key)`))
app.on('will-quit',()=>{server.close();rmSync(directory,{recursive:true,force:true})})
require(resolve('out/main/index.js'))
