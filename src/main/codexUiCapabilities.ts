import {parse} from 'acorn'

export type CodexUiFeature='locale'|'speed'|'ultra'
export const codexUiFeatures:readonly CodexUiFeature[]=['locale','speed','ultra']
export interface CodexUiReplacement {begin:string;end:string;before:string;after:string;offset?:number}
export interface CodexUiFeatureSupport {supported:boolean;reason:string}
export type CodexUiFeatureSupports=Record<CodexUiFeature,CodexUiFeatureSupport>
type Node={type:string;start:number;end:number;[key:string]:any}
const label:Record<CodexUiFeature,string>={locale:'页面语言',speed:'普通 / Fast',ultra:'Ultra 推理'}
const literal=(node:Node|undefined):unknown=>node?.type==='Literal'?node.value:node?.type==='TemplateLiteral'&&node.expressions.length===0?node.quasis[0].value.cooked:undefined
const property=(node:Node|undefined):string|undefined=>node?.type==='MemberExpression'&&!node.computed?node.property.name:undefined
const unwrap=(node:Node):Node=>node.type==='ChainExpression'?node.expression:node
function visit(root:Node,fn:(node:Node)=>void):void {
  const stack=[root]
  while(stack.length){
    const node=stack.pop()!;fn(node)
    for(const value of Object.values(node)){
      if(value&&typeof value==='object'&&typeof value.type==='string')stack.push(value)
      else if(Array.isArray(value))for(const child of value)if(child&&typeof child.type==='string')stack.push(child)
    }
  }
}
const nodes=(root:Node,predicate:(node:Node)=>boolean):Node[]=>{const found:Node[]=[];visit(root,node=>{if(predicate(node))found.push(node)});return found}
const one=<T>(values:readonly T[]):T=>{if(values.length!==1)throw new Error('ambiguous feature shape');return values[0]}

/** Match semantic roles and syntax, never minifier names or release numbers.
 * Every feature is a transaction: ambiguous/missing roles discard its complete
 * patch set. Model capability and upstream fast_mode requirements remain intact.
 */
export function detectCodexUiCapabilities(source:string):{features:CodexUiFeatureSupports;replacements:Record<CodexUiFeature,CodexUiReplacement[]>} {
  const features={} as CodexUiFeatureSupports,replacements:Record<CodexUiFeature,CodexUiReplacement[]>={locale:[],speed:[],ultra:[]}
  let functions:Node[]
  try{functions=nodes(parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,n=>n.type==='FunctionDeclaration')}
  catch{
    for(const feature of codexUiFeatures)features[feature]={supported:false,reason:`${label[feature]}：无法确认客户端页面结构`}
    return {features,replacements}
  }
  const text=(node:Node)=>source.slice(node.start,node.end)
  const functionsWith=(...terms:string[])=>functions.filter(fn=>{const body=text(fn);return terms.every(term=>body.includes(term))})
  const edit=(node:Node,after:string):CodexUiReplacement=>({begin:'',end:'',offset:node.start,before:text(node),after})
  const transaction=(feature:CodexUiFeature,detect:()=>CodexUiReplacement[])=>{
    try{
      const edits=detect().sort((a,b)=>b.offset!-a.offset!)
      if(!edits.length||edits.some((e,i)=>!e.before||e.after===e.before||(i>0&&e.offset!+e.before.length>edits[i-1].offset!)))throw new Error('overlapping feature edits')
      replacements[feature]=edits;features[feature]={supported:true,reason:`${label[feature]}：已通过功能结构检测`}
    }catch{features[feature]={supported:false,reason:`${label[feature]}：客户端结构已变化，等待适配`}}
  }
  transaction('locale',()=>{
    const fn=one(functionsWith('locale_source','enable_i18n','systemLocale','ideLocale','Failed to load locale messages'))
    const declaration=one(nodes(fn,n=>n.type==='VariableDeclaration'&&n.declarations.some((d:Node)=>d.init&&nodes(d.init,c=>c.type==='CallExpression'&&literal(c.arguments[0])==='locale_source').length===1)))
    const locale=one(declaration.declarations.filter((d:Node)=>d.init&&nodes(d.init,c=>c.type==='CallExpression'&&literal(c.arguments[0])==='locale_source').length===1)) as Node
    const enabled=one(declaration.declarations.filter((d:Node)=>d!==locale&&d.init?.type==='Identifier')) as Node
    const system=one(nodes(fn,n=>n.type==='ChainExpression'&&property(n.expression)==='systemLocale'))
    return [edit(enabled.init,'!0'),edit(locale.init,`${text(system)}?\`SYSTEM\`:\`IDE\``)]
  })
  transaction('speed',()=>{
    const ui=one(functionsWith('isServiceTierAllowed','authMethod','fast_mode'))
    const auth=one(nodes(ui,n=>n.type==='VariableDeclarator'&&n.init&&text(n.init).includes('authMethod')&&nodes(n.init,c=>c.type==='BinaryExpression'&&c.operator==='==='&&literal(c.right)==='chatgpt').length===1))
    const account=one(nodes(auth.init,n=>n.type==='MemberExpression'&&property(n)==='authMethod'&&n.object.type==='Identifier').map(n=>n.object.name).filter((v,i,a)=>a.indexOf(v)===i))
    const host=one(nodes(ui,n=>n.type==='Property'&&n.key.name==='hostId'&&n.value.type==='Identifier').map(n=>n.value.name).filter((v,i,a)=>a.indexOf(v)===i))
    const custom=`${host}===\`local\`&&(${account}?.authMethod===\`apikey\`||${account}?.authMethod===null&&${account}?.requiresAuth===!1)`
    const query=one(nodes(ui,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending')))
    const data=one<Node>(query.id.properties.filter((p:Node)=>p.key.name==='data')).value.name
    const pending=one<Node>(query.id.properties.filter((p:Node)=>p.key.name==='isPending')).value.name
    const loading=one(nodes(ui,n=>n.type==='VariableDeclarator'&&n.init&&text(n.init).includes('isLoading')))
    const queryPending=one(nodes(loading.init,n=>n.type==='LogicalExpression'&&n.operator==='&&'&&n.left.name===auth.id.name&&n.right.name===pending))
    const needsData=one(nodes(ui,n=>n.type==='BinaryExpression'&&n.operator==='!='&&n.left.name===data&&literal(n.right)===null))
    const controls=one(functionsWith('isServiceTierAllowed','serviceTierSettings','availableOptions','setServiceTier'))
    const controlQuery=one(nodes(controls,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='isPending')))
    const controlPending=one<Node>(controlQuery.id.properties.filter((p:Node)=>p.key.name==='isPending')).value.name
    const permitted=one(nodes(controls,n=>n.type==='Property'&&n.key.name==='isServiceTierAllowed'&&n.value.type==='Identifier')).value.name
    const controlLoading=one(nodes(controls,n=>n.type==='LogicalExpression'&&n.operator==='&&'&&n.right.name===controlPending&&n.left.type==='BinaryExpression'&&n.left.operator==='=='&&literal(n.left.right)===null))
    const confirm=one(functionsWith('authMethod:','fast_mode','return!1').filter(fn=>fn.async))
    const guard=one(nodes(confirm,n=>n.type==='IfStatement'&&n.consequent.type==='ReturnStatement'&&text(n.test).includes('chatgpt')&&text(n.consequent)==='return!1;'))
    const method=one(nodes(guard.test,n=>n.type==='BinaryExpression'&&literal(n.right)==='chatgpt'&&n.left.type==='Identifier')).left.name
    const methodRead=one(nodes(confirm,n=>n.type==='VariableDeclarator'&&n.id.name===method&&n.init?.type==='AwaitExpression')).init.argument
    if(methodRead.type!=='CallExpression'||methodRead.callee.type!=='Identifier'||methodRead.arguments.length!==2||methodRead.arguments.some((a:Node)=>a.type!=='Identifier'))throw new Error('auth reader')
    const helper=one(functions.filter(fn=>fn.id?.name===methodRead.callee.name))
    const rpc=one(nodes(helper,n=>n.type==='CallExpression'&&property(unwrap(n.callee))==='getAccount'))
    const receiver=unwrap(rpc.callee).object
    if(property(receiver)!=='rpc'||receiver.object.type!=='Identifier')throw new Error('account RPC')
    const accessor=one(nodes(helper,n=>n.type==='VariableDeclarator'&&n.id.name===receiver.object.name&&n.init?.type==='CallExpression')).init
    const wrapper=one(nodes(helper,n=>n.type==='CallExpression'&&n.arguments.length===1&&n.arguments[0]===rpc))
    if(wrapper.callee.type!=='Identifier'||accessor.arguments.length!==2)throw new Error('account reader')
    const [scopeId,hostId]=methodRead.arguments.map((n:Node)=>n.name)
    if(property(accessor.callee)!=='get'||accessor.callee.object?.name!==helper.params[0]?.name||accessor.arguments[0].type!=='Identifier'||accessor.arguments[1].name!==helper.params[1]?.name)throw new Error('account scope')
    const call=`${text(wrapper.callee)}(${scopeId}.get(${text(accessor.arguments[0])},${hostId})?.rpc.getAccount({priority:\`critical\`}))`
    const fallback=`if(${method}!==\`chatgpt\`&&${method}!==\`personalAccessToken\`&&${method}!==\`apikey\`){if(${method}!==null||${hostId}!==\`local\`)return!1;let __cmlAccount;try{__cmlAccount=await ${call}}catch{return!1}if(__cmlAccount?.account!==null||__cmlAccount?.requiresOpenaiAuth!==!1)return!1;}`
    const requirements=one(nodes(confirm,n=>n.type==='AwaitExpression'&&n.argument.type==='CallExpression'&&n.argument!==methodRead))
    const optionalRequirements=`await ${text(requirements.argument)}.catch(__cmlError=>{if(${hostId}===\`local\`&&(${method}===\`apikey\`||${method}===null))return {requirements:null};throw __cmlError})`
    // Signed-in requirements do not exist for custom API providers. Preserve
    // their explicit Fast denial when present, without waiting indefinitely
    // for an unrelated ChatGPT workspace request. Null identities were verified
    // through account/read above before this request-time fallback is reached.
    return [edit(auth.init,`${text(auth.init)}||${account}?.authMethod===\`apikey\`||${host}===\`local\`&&${account}?.authMethod===null&&${account}?.requiresAuth===!1`),edit(queryPending,`${text(queryPending)}&&!(${custom})`),edit(needsData,`(${text(needsData)}||(${custom}))`),edit(controlLoading,`${text(controlLoading)}&&!${permitted}`),edit(guard,fallback),edit(requirements,optionalRequirements)]
  })
  transaction('ultra',()=>{
    const settings=one(functionsWith('enabledReasoningEfforts','new Set','persistent').filter(fn=>nodes(fn,n=>n.type==='NewExpression'&&n.callee.name==='Set'&&n.arguments[0]?.type==='ArrayExpression'&&text(n.arguments[0]).includes('enabledReasoningEfforts')&&n.arguments[0].elements.some((e:Node)=>literal(e)==='persistent')).length===1))
    const values=one(nodes(settings,n=>n.type==='NewExpression'&&n.callee.name==='Set'&&n.arguments[0]?.type==='ArrayExpression'&&text(n.arguments[0]).includes('enabledReasoningEfforts')&&n.arguments[0].elements.some((e:Node)=>literal(e)==='persistent'))).arguments[0]
    if(values.elements.some((e:Node)=>literal(e)==='ultra'))throw new Error('native ultra shape')
    const catalogue=one(functionsWith('includeUltraReasoningEffort','hasModelSupportingUltraReasoningEffort','supportedReasoningEfforts.filter'))
    const availability=one(nodes(catalogue,n=>n.type==='VariableDeclarator'&&n.init?.type==='LogicalExpression'&&n.init.operator==='&&'&&text(n.init.right).includes('supportedReasoningEfforts')&&text(n.init.right).includes('ultra'))).init
    const filtered=one(nodes(catalogue,n=>n.type==='ConditionalExpression'&&property(n.consequent)==='supportedReasoningEfforts'&&text(n.alternate).includes('supportedReasoningEfforts.filter')&&text(n.alternate).includes('ultra')))
    const gates:Node[]=[]
    for(const fn of functionsWith('536305374','ultra').filter(fn=>['thinkingEffort','reasoningEffort','includeUltraReasoningEffort'].some(term=>text(fn).includes(term))))
      gates.push(...nodes(fn,n=>n.type==='CallExpression'&&n.arguments.length===2&&literal(n.arguments[1])==='536305374'&&(n.callee.type==='Identifier'||property(n.callee)==='get')))
    const unique=[...new Map(gates.map(n=>[n.start,n])).values()]
    if(unique.length<3||unique.length>12)throw new Error('ultra persistence roles')
    return [edit(values,text(values).slice(0,-1)+',`ultra`]'),edit(availability,text(availability.right)),edit(filtered,text(filtered.consequent)),...unique.map(gate=>edit(gate,'!0'))]
  })
  return {features,replacements}
}

export function applyCodexUiReplacements(source:string,replacements:readonly CodexUiReplacement[]):string {
  let result=source
  for(const replacement of [...replacements].sort((a,b)=>b.offset!-a.offset!)){
    const at=replacement.offset
    if(!Number.isSafeInteger(at)||at!<0||result.slice(at,at!+replacement.before.length)!==replacement.before)throw new Error('feature source mismatch')
    result=result.slice(0,at)+replacement.after+result.slice(at!+replacement.before.length)
  }
  // Validate the complete module after independently selected patches compose.
  parse(result,{ecmaVersion:'latest',sourceType:'module'})
  return result
}
