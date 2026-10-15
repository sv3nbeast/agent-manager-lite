import {spawn} from 'node:child_process'

/** Only Desktop authentication callbacks may be delivered to an instance.
 * Tokens remain transient; never include the URL in logs, errors or argv. */
export function validateClaudeDesktopLoginUrl(value:string):string {
  if(typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f]/.test(value))throw new Error('请粘贴完整的 Claude 桌面登录回调链接')
  let url:URL
  try{url=new URL(value)}catch{throw new Error('Claude 登录回调链接无效')}
  const allowed=url.protocol==='claude:'&&!url.username&&!url.password&&!url.port&&(
    url.hostname==='login'&&url.pathname==='/google-auth'&&!!url.searchParams.get('code')
    ||url.hostname==='claude.ai'&&['/magic-link','/sso-callback'].includes(url.pathname)&&!!(url.search||url.hash))
  if(!allowed)throw new Error('仅接受 Claude Desktop 的 Google、邮件或 SSO 登录回调链接')
  return value
}

// Address the AppleEvent by PID, not bundle ID: multiple Claude instances
// intentionally have the same signed application identity.
const deliverScript=`ObjC.import('Foundation');
const bytes=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const data=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes,$.NSUTF8StringEncoding)));
const target=$.NSAppleEventDescriptor.descriptorWithProcessIdentifier(data.pid);
const event=$.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x4755524c,0x4755524c,target,-1,0);
event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(data.url),0x2d2d2d2d);
const error=Ref();event.sendEventWithOptionsTimeoutError(0x1011,5,error);
if(!error[0].isNil())throw new Error('delivery failed');
'sent';`

export async function sendClaudeDesktopLoginUrl(pid:number,value:string):Promise<void> {
  const url=validateClaudeDesktopLoginUrl(value)
  if(process.platform!=='darwin'||!Number.isSafeInteger(pid)||pid<2)throw new Error('Claude Desktop 登录回调目标无效')
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('/usr/bin/osascript',['-l','JavaScript','-e',deliverScript],{stdio:['pipe','pipe','ignore']})
    let output='',settled=false
    const finish=(success:boolean)=>{
      if(settled)return;settled=true;clearTimeout(timer)
      if(success)resolve();else reject(new Error('无法把登录链接发送到此实例，请确认 macOS 自动化权限后重试'))
    }
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(false)},8000)
    child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-64)})
    child.on('error',()=>finish(false));child.on('close',code=>finish(code===0&&output.trim()==='sent'))
    child.stdin.on('error',()=>finish(false));child.stdin.end(JSON.stringify({pid,url}))
  })
}
