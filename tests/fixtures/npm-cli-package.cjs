// Temporary official-layout fixture; no launcher JavaScript is executed.
const {mkdirSync,copyFileSync,writeFileSync,chmodSync}=require('node:fs')
const {join,dirname}=require('node:path')
function npmCliPackage(directory,binary,layout='optional'){
  const root=join(directory,'node_modules','@openai','codex'),entry=join(root,'bin','codex.js')
  const name=`@openai/codex-${process.platform}-${process.arch}`
  mkdirSync(dirname(entry),{recursive:true})
  copyFileSync(join(__dirname,'codex-npm-launcher.js'),entry);chmodSync(entry,0o700)
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.153.2',bin:{codex:'bin/codex.js'},optionalDependencies:{[name]:`npm:@openai/codex@0.153.2-${process.platform}-${process.arch}`}}))
  const platformRoot=join(root,'node_modules',name)
  if(layout==='optional'){mkdirSync(platformRoot,{recursive:true});writeFileSync(join(platformRoot,'package.json'),JSON.stringify({name:'@openai/codex',version:`0.153.2-${process.platform}-${process.arch}`}))}
  const triple=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux-musl'}`
  const executable=join(layout==='optional'?platformRoot:root,'vendor',triple,'bin','codex')
  mkdirSync(dirname(executable),{recursive:true});copyFileSync(binary,executable);chmodSync(executable,0o700)
  return {root,entry,executable,platformRoot}
}
module.exports={npmCliPackage}
