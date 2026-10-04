// Crash-only fixture: isolated temporary root and fake client passed by test.
import {Store} from '../../src/main/store'
import {OfficialTempLogin} from '../../src/main/tempLogin'
import {MacDesktopRuntime} from '../../src/main/instanceRuntime'
const [directory,application]=process.argv.slice(2)
if(!directory.includes('cml-temp-login-')||!application.includes('cml-temp-login-'))throw new Error('Not a temporary fixture')
const runtime=new MacDesktopRuntime(),launch=runtime.launch.bind(runtime)
runtime.launch=async(plan,signal)=>{const child=await launch(plan,signal);process.kill(process.pid,'SIGKILL');return child}
const store=new Store(directory,{encrypt:()=>{throw new Error('No fixture credential save')},decrypt:()=>{throw new Error('No fixture vault read')}})
const service=new OfficialTempLogin(store,()=>[{id:'fixture',name:'Fixture',path:application}],runtime)
service.start({applicationId:'fixture',interceptAuthUrl:false})
void service.settled().then(()=>{throw new Error('Crash fixture unexpectedly returned')})
