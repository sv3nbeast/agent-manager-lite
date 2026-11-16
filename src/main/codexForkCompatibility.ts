import {parse} from 'acorn'
import {codexUiRspackModules,type CodexUiReplacement} from './codexUiCapabilities'

type Node={type:string;start:number;end:number;[key:string]:any}
type Atom={module:string;export:string}
export interface CodexForkPlacementContract {identity:Atom;sections:Atom;sort:Atom;legacySort:Atom}
function nodes(root:Node,predicate:(node:Node)=>boolean):Node[]{
  const found:Node[]=[],queue=[root]
  while(queue.length){
    const node=queue.pop()!
    if(predicate(node))found.push(node)
    for(const value of Object.values(node)){
      if(value&&typeof value==='object'&&typeof value.type==='string')queue.push(value)
      else if(Array.isArray(value))for(const child of value)if(child&&typeof child.type==='string')queue.push(child)
    }
  }
  return found
}
const literal=(node:Node|undefined):unknown=>node?.type==='Literal'?node.value:node?.type==='TemplateLiteral'&&!node.expressions.length?node.quasis[0].value.cooked:undefined
const member=(node:Node|undefined,key:string)=>node?.type==='MemberExpression'&&!node.computed&&node.property?.name===key
const key=(node:Node)=>node.key?.name??literal(node.key)
const field=(node:Node|undefined,name:string):Node|undefined=>node?.type==='ObjectExpression'?node.properties.find((p:Node)=>p.type==='Property'&&!p.computed&&key(p)===name)?.value:undefined
const one=<T>(items:T[]):T=>{if(items.length!==1)throw new Error('ambiguous fork contract');return items[0]}
const tree=(source:string)=>parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node

function exported(program:Node,binding:string):string {
  return one(nodes(program,n=>n.type==='CallExpression'&&member(n.callee,'d')).flatMap(call=>call.arguments.slice(1).filter((arg:Node)=>arg.type==='ObjectExpression').flatMap((object:Node)=>object.properties.filter((p:Node)=>p.type==='Property'&&!p.computed&&(p.value?.name===binding||p.value?.type==='ArrowFunctionExpression'&&p.value.body?.name===binding)).map((p:Node)=>String(key(p))))))
}

/** Resolve the installed renderer's own authentication, grouping and sorting
 * atoms. No module id, minifier binding or release version is an allowlist. */
export function codexForkPlacementContract(source:string):CodexForkPlacementContract|undefined {
  try{
    const identity:Atom[]=[],sections:Atom[]=[],sort:Atom[]=[],legacySort:Atom[]=[]
    for(const module of codexUiRspackModules(source)){
      if(!['authLoading','authenticatedAccountId','codex-sidebar-sort-mode-v1','flat-project-sidebar-preferences-v1'].some(term=>module.source.includes(term)))continue
      const program=tree(module.source)
      const declarations=(program.body??[]).flatMap((statement:Node)=>statement.type==='VariableDeclaration'?statement.declarations:[]).filter((d:Node)=>d.id?.type==='Identifier')
      const atom=(declaration:Node):Atom=>({module:module.id,export:exported(program,declaration.id.name)})
      for(const d of declarations){
        if(d.init?.type!=='CallExpression')continue
        const setting=literal(d.init.arguments[0])
        if(setting==='codex-sidebar-sort-mode-v1')sort.push(atom(d))
        if(setting==='flat-project-sidebar-preferences-v1')legacySort.push(atom(d))
        const returns=nodes(d.init,n=>n.type==='ReturnStatement'&&n.argument?.type==='ObjectExpression')
        if(returns.some(n=>['authLoading','authMethod','requiresAuth','accountLoading','authenticatedAccountId'].every(name=>!!field(n.argument,name))))identity.push(atom(d))
        const checks=nodes(d.init,n=>n.type==='BinaryExpression'&&n.operator==='!='&&literal(n.left)===null&&n.right?.type==='CallExpression'&&n.right.arguments.length===1&&n.right.arguments[0]?.type==='Identifier')
        if(checks.length!==1)continue
        const account=declarations.find((a:Node)=>a.id.name===checks[0].right.arguments[0].name)
        const body=account?.init?module.source.slice(account.init.start,account.init.end):''
        if(body.includes('authenticatedAccountId')&&body.includes('accountId')&&body.includes('allowed')&&nodes(account!.init,n=>n.type==='ReturnStatement'&&n.argument?.type==='ConditionalExpression'&&literal(n.argument.alternate)===null).length===1)sections.push(atom(d))
      }
    }
    return {identity:one(identity),sections:one(sections),sort:one(sort),legacySort:one(legacySort)}
  }catch{return undefined}
}

/** Supply native placement before the background fork RPC only for a ready
 * local API identity with custom sections disabled. The native RPC still owns
 * configuration loading, execution permissions, history and account checks. */
export function codexForkPlacementReplacements(source:string,contract:CodexForkPlacementContract):CodexUiReplacement[]{
  try{
    const program=tree(source),text=(node:Node)=>source.slice(node.start,node.end)
    const fn=one(nodes(program,n=>n.type==='FunctionDeclaration'&&n.async&&n.params?.length===3&&n.params.every((p:Node)=>p.type==='Identifier')&&['forkConversationFromTurn','forkConversationFromLatest','readResumeInputs'].every(term=>text(n).includes(term))))
    const [scope,host,params]=fn.params.map((p:Node)=>p.name)
    const declaration=one(nodes(fn,n=>n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='ObjectExpression'&&['readResumeInputs','sourceTitle','afterConversationCreated'].every(name=>!!field(n.init,name))))
    const spread=declaration.init.properties[0]
    if(spread?.type!=='SpreadElement'||spread.argument.name!==params||field(declaration.init,'placement')||text(fn).includes('cmlForkIdentity'))return []
    one(nodes(fn,n=>n.type==='CallExpression'&&member(n.callee,'forkConversationFromLatest')&&n.arguments.length===1&&n.arguments[0]?.name===declaration.id.name))
    const loaders=[...new Set(nodes(program,n=>n.type==='VariableDeclarator'&&n.init?.type==='CallExpression'&&n.init.callee.type==='Identifier'&&n.init.arguments.length===1&&typeof literal(n.init.arguments[0])==='string').map(n=>n.init.callee.name))]
    const requireName=one(loaders)
    if(nodes(program,n=>n.type==='Identifier'&&n.name==='__cmlReadForkAtoms').length)return []
    const atoms=[contract.identity,contract.sections,contract.sort,contract.legacySort]
    const get=(atom:Atom)=>`${scope}.get(__cmlReadForkAtoms()[${atoms.indexOf(atom)}])`
    const after=`${text(spread)},...(()=>{if(${params}.placement!==undefined||${host}!=="local"||${scope}==null)return{};const cmlForkIdentity=${get(contract.identity)};if(cmlForkIdentity?.authLoading!==false||!(cmlForkIdentity.authMethod==="apikey"||cmlForkIdentity.authMethod===null&&cmlForkIdentity.requiresAuth===false)||${get(contract.sections)}!==false)return{};const current=${get(contract.sort)},legacy=${get(contract.legacySort)},valid=value=>["manual","priority","created_at","updated_at"].includes(value);return{placement:{prependToManualProject:(valid(current)?current:valid(legacy?.projectSortMode)?legacy.projectSortMode:undefined)==="manual",customSection:null}}})()`
    const first=program.body.find((node:Node)=>!node.directive) as Node
    const loader=`const __cmlReadForkAtoms=()=>[${atoms.map(atom=>`${requireName}(${JSON.stringify(atom.module)})[${JSON.stringify(atom.export)}]`).join(',')}];`
    return [{begin:'',end:'',offset:spread.start,before:text(spread),after},{begin:'',end:'',offset:first.start,before:text(first),after:loader+text(first)}]
  }catch{return []}
}
