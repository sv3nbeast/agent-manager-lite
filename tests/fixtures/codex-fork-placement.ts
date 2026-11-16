// Synthetic native contracts, never an upstream bundle or real account data.
export const forkWrapper=`var service=n("service");
class ForkError extends Error { constructor(result){super("App-server fork is not ready: "+result.reason)} }
async function fork(scope,host,n){
  let request={...n,readResumeInputs:n.readResumeInputs??service.inputs,sourceTitle:n.sourceTitle,afterConversationCreated:n.afterConversationCreated};
  const result="targetTurnId" in n?await service.forkConversationFromTurn({...request,targetTurnId:n.targetTurnId}):await service.forkConversationFromLatest(request);
  if(result.status==="not-ready")throw new ForkError(result);
  return result;
}`
export const forkPlacementFixture=`export const __webpack_modules__={
  identityModule(e,t,n){let identity=atom(root,()=>{return {authLoading:true,authMethod:null,requiresAuth:true,accountLoading:true,authenticatedAccountId:null}});n.d(t,{},{auth:identity})},
  groupingModule(e,t,n){let account=atom(root,({get})=>{let value=get(active);return value.status==="allowed"&&value.accountId===get(identity).authenticatedAccountId?value.accountId:null}),enabled=atom(root,({get})=>null!=get(account));n.d(t,{},{grouping:enabled})},
  sortingModule(e,t,n){let mode=setting("codex-sidebar-sort-mode-v1",void 0),legacy=setting("flat-project-sidebar-preferences-v1",{});n.d(t,{},{current:mode,previous:legacy})},
  forkModule(e,t,n){${forkWrapper}}
}`
