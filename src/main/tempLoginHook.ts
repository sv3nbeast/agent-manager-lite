// Adapted from Cockpit codex_temp_login_auth_hook.cjs (pinned source in notices).
// Written only into the explicitly created temporary profile; never changes
// the installed application. A failed capture must preserve browser login.
export const TEMP_LOGIN_HOOK=String.raw`
'use strict';
(function(){
  const capture=process.env.CML_TEMP_LOGIN_CAPTURE;
  if(!capture||process.type!=='browser')return;
  const fs=require('node:fs');
  function append(record){
    let fd;
    try{
      fd=fs.openSync(capture,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)return false;
      fs.writeFileSync(fd,JSON.stringify(record)+'\n');return true;
    }catch{return false}finally{if(fd!==undefined)fs.closeSync(fd)}
  }
  function official(value){
    if(typeof value!=='string'||value.length>16384)return false;
    try{
      const url=new URL(value);
      return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&
        (url.hostname==='auth.openai.com'&&url.pathname==='/oauth/authorize'||
        (url.hostname==='chatgpt.com'||url.hostname.endsWith('.chatgpt.com'))&&url.pathname==='/codex/desktop-auth');
    }catch{return false}
  }
  function install(shell){
    try{
      if(!shell||typeof shell.openExternal!=='function')return false;
      if(shell.openExternal.__cmlTempLogin)return true;
      const original=shell.openExternal.bind(shell);
      const patched=function(url,options){
        if(official(url)&&append({kind:'url',url}))return Promise.resolve();
        return original(url,options);
      };
      patched.__cmlTempLogin=true;shell.openExternal=patched;
      append({kind:'armed'});return true;
    }catch{append({kind:'error'});return false}
  }
  try{
    const Module=require('module'),load=Module._load;
    Module._load=function(request){const loaded=load.apply(this,arguments);if(request==='electron'||request==='electron/main')install(loaded&&loaded.shell);return loaded};
    let attempts=0;
    const timer=setInterval(()=>{let patched=false;try{patched=install(require('electron').shell)}catch{}if(patched||++attempts>=80)clearInterval(timer)},250);
    timer.unref?.();
  }catch{append({kind:'error'})}
})();
`
export function isOfficialLoginURL(value:string):boolean {
  if(value.length>16384)return false
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&
    (url.hostname==='auth.openai.com'&&url.pathname==='/oauth/authorize'||(url.hostname==='chatgpt.com'||url.hostname.endsWith('.chatgpt.com'))&&url.pathname==='/codex/desktop-auth')}
  catch{return false}
}
