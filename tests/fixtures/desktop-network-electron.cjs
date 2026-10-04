// A windowless fixture, with a temporary user-data directory. This never loads
// or automates the installed Codex application or its real account/profile.
const {app,net}=require('electron')
app.setPath('userData',process.env.CML_NETWORK_FIXTURE_HOME)
app.whenReady().then(async()=>{
  const fetch=async(url)=>{
    try{
      const response=await net.fetch(url,{signal:AbortSignal.timeout(3000)})
      return {status:response.status,body:await response.text()}
    }catch(error){return {failed:true,error:error.message}}
  }
  const external=await fetch(process.env.CML_NETWORK_FIXTURE_EXTERNAL??'http://cml-desktop-network.invalid/translation-fixture')
  const local=await fetch(process.env.CML_NETWORK_FIXTURE_LOCAL)
  console.log('CML_NETWORK_RESULT:'+JSON.stringify({external,local}))
  app.quit()
}).catch(()=>app.exit(1))
setTimeout(()=>app.exit(2),10000).unref()
