import {parse} from 'acorn'

export type CodexUiFeature='locale'|'speed'|'ultra'
export const codexUiFeatures:readonly CodexUiFeature[]=['locale','speed','ultra']
export interface CodexUiReplacement {begin:string;end:string;before:string;after:string;offset?:number}
export interface CodexUiFeatureSupport {supported:boolean;reason:string}
export type CodexUiFeatureSupports=Record<CodexUiFeature,CodexUiFeatureSupport>
type Node={type:string;start:number;end:number;[key:string]:any}
const label:Record<CodexUiFeature,string>={locale:'页面语言',speed:'普通 / Fast',ultra:'Ultra 推理'}
const literal=(node:Node|undefined):unknown=>node?.type==='Literal'?node.value:node?.type==='TemplateLiteral'&&node.expressions.length===0?node.quasis[0].value.cooked:undefined
const booleanLiteral=(node:Node|undefined):boolean|undefined=>{const value=literal(node);if(typeof value==='boolean')return value;if(node?.type==='UnaryExpression'&&node.operator==='!'&&typeof literal(node.argument)==='number')return !literal(node.argument);return undefined}
const property=(node:Node|undefined):string|undefined=>node?.type==='MemberExpression'&&!node.computed?node.property.name:undefined
const unwrap=(node:Node):Node=>node.type==='ChainExpression'?node.expression:node
function memberPath(node:Node|undefined):string[]{if(!node)return[];node=unwrap(node);if(node.type==='Identifier')return[node.name];if(node.type!=='MemberExpression')return[];const key=node.computed?literal(node.property):node.property?.name;return typeof key==='string'?[...memberPath(node.object),key]:[]}
function resolvedMemberPath(node:Node|undefined,scope:Node,seen=new Set<string>()):string[]{
  if(!node)return[]
  node=unwrap(node)
  if(node.type==='Identifier'){
    if(seen.has(node.name))return[]
    seen.add(node.name)
    const aliases=nodes(scope,n=>n.type==='VariableDeclarator'&&n.id?.type==='Identifier'&&n.id.name===node.name)
    return aliases.length===1&&aliases[0].init?resolvedMemberPath(aliases[0].init,scope,seen):[node.name]
  }
  if(node.type!=='MemberExpression')return[]
  const key=node.computed?literal(node.property):node.property?.name
  return typeof key==='string'?[...resolvedMemberPath(node.object,scope,seen),key]:[]
}
const isFunction=(node:Node|undefined):boolean=>Boolean(node&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))

/**
 * Return only functions which are bound in the module scope.  Walking every
 * FunctionDeclaration below Program used to make a nested helper look like a
 * second feature role (or make a nested function satisfy a role by itself).
 * Function expressions and arrows are common output from newer bundlers, so
 * their VariableDeclarator binding is part of the same contract.
 */
function moduleFunctions(program:Node):Node[] {
  const functions:Node[]=[]
  const add=(fn:Node,name:string|undefined)=>{
    if(name)fn.__cmlBindingName=name
    functions.push(fn)
  }
  const statement=(node:Node|undefined)=>{
    if(!node)return
    if(node.type==='FunctionDeclaration'){
      if(node.id?.type==='Identifier')add(node,node.id.name)
      return
    }
    if(node.type==='VariableDeclaration'){
      for(const declaration of node.declarations??[]){
        if(declaration.id?.type==='Identifier'&&isFunction(declaration.init))add(declaration.init,declaration.id.name)
      }
      return
    }
    // A module export still binds its declaration at Program scope.
    if(['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(node.type))statement(node.declaration)
  }
  for(const node of program.body??[])statement(node)
  return functions
}

const functionName=(fn:Node):string|undefined=>fn.__cmlBindingName??fn.id?.name
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
function bindingNames(pattern:Node|undefined):string[] {
  if(!pattern)return []
  if(pattern.type==='Identifier')return [pattern.name]
  if(pattern.type==='RestElement')return bindingNames(pattern.argument)
  if(pattern.type==='AssignmentPattern')return bindingNames(pattern.left)
  if(pattern.type==='ArrayPattern')return pattern.elements.flatMap(bindingNames)
  if(pattern.type==='ObjectPattern')return pattern.properties.flatMap((p:Node)=>bindingNames(p.type==='RestElement'?p.argument:p.value))
  return []
}
function localBindings(fn:Node):Set<string> {
  return new Set(nodes(fn,n=>['VariableDeclarator','FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','CatchClause'].includes(n.type)).flatMap(n=>[...bindingNames(n.id),...(n.params??[]).flatMap(bindingNames),...bindingNames(n.param)]))
}

/** Match semantic roles and syntax, never minifier names or release numbers.
 * Every feature is a transaction: ambiguous/missing roles discard its complete
 * patch set. Model capability and upstream fast_mode requirements remain intact.
 */
export function codexUiAccessMapperImportPaths(source:string):string[] {
  try{
    const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node
    const functions=moduleFunctions(program)
    const uiCandidates=functions.filter(fn=>textOf(source,fn).includes('authMethod')&&textOf(source,fn).includes('isLoading')&&nodes(fn,n=>n.type==='Property'&&n.key?.name==='serviceTierAccess').length===1)
    const ui=one(uiCandidates.filter(fn=>{
      const query=nodes(fn,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending'))
      if(query.length!==1)return false
      const data=query[0].id.properties.find((p:Node)=>p.key.name==='data')?.value?.name
      return nodes(fn,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.arguments.length===1&&n.arguments[0].name===data).length===1
    }))
    const query=one(nodes(ui,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending')))
    const data=one<Node>(query.id.properties.filter((p:Node)=>p.key.name==='data')).value.name
    const mapper=one(nodes(ui,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.arguments.length===1&&n.arguments[0].name===data).map((node:Node)=>node.callee.name))
    const imports=(program.body??[]).filter((node:Node)=>node.type==='ImportDeclaration'&&node.specifiers.some((specifier:Node)=>specifier.local?.name===mapper))
    if(imports.length!==1||typeof imports[0].source?.value!=='string'||!/^\.\/[\w.-]+\.js$/.test(imports[0].source.value))return[]
    return [imports[0].source.value]
  }catch{return []}
}
function textOf(source:string,node:Node):string{return source.slice(node.start,node.end)}

export function detectCodexUiCapabilities(source:string,importedModules:Readonly<Record<string,string>>={}):{features:CodexUiFeatureSupports;replacements:Record<CodexUiFeature,CodexUiReplacement[]>} {
  const features={} as CodexUiFeatureSupports,replacements:Record<CodexUiFeature,CodexUiReplacement[]>={locale:[],speed:[],ultra:[]}
  let functions:Node[],program:Node
  try{program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node;functions=moduleFunctions(program)}
  catch{
    for(const feature of codexUiFeatures)features[feature]={supported:false,reason:`${label[feature]}：无法确认客户端页面结构`}
    return {features,replacements}
  }
  const text=(node:Node)=>source.slice(node.start,node.end)
  const functionsWith=(...terms:string[])=>functions.filter(fn=>{
    const body=text(fn)
    if(!terms.every(term=>body.includes(term)))return false
    // A module-level wrapper may contain a nested function which has the
    // complete semantic signature.  Treat the nested function as the role's
    // owner; otherwise the wrapper would create a false ambiguity.
    return !nodes(fn,n=>n!==fn&&isFunction(n)&&terms.every(term=>text(n).includes(term))).length
  })
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
    // Newer clients expose an access object (Fast and Ultra Fast) instead of
    // one boolean. Follow the returned capability and its requirements mapper;
    // preserve the official tier rules rather than depending on build names.
    const uiCandidates=functionsWith('authMethod','isLoading').filter(fn=>nodes(fn,n=>n.type==='Property'&&['isServiceTierAllowed','serviceTierAccess'].includes(n.key.name)).length===1)
    const ui=one(uiCandidates.filter(fn=>{
      if(!nodes(fn,n=>n.type==='Property'&&n.key.name==='serviceTierAccess').length)return true
      const queries=nodes(fn,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending'))
      if(queries.length!==1)return false
      const dataName=queries[0].id.properties.find((p:Node)=>p.key.name==='data')?.value?.name
      return nodes(fn,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.arguments.length===1&&n.arguments[0].name===dataName).length===1
    }))
    const capability=one(nodes(ui,n=>n.type==='Property'&&['isServiceTierAllowed','serviceTierAccess'].includes(n.key.name))).key.name
    const accessObject=capability==='serviceTierAccess'
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
    const accessCall=accessObject?one(nodes(ui,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.arguments.length===1&&n.arguments[0].name===data)):undefined
    const access=accessCall?.callee.name
    const mapper=access
    const confirmations=functionsWith('authMethod:').filter(fn=>fn.async&&text(fn).includes('fast_mode'))
    // The newer menu obtains its access decision from the existing per-host
    // requirements query and maps it with the client's fCe requirements
    // function. Allow only an explicit API-key identity on the local host to
    // use that same path. Do not invent an unauthenticated identity, bypass
    // requirements loading, or alter the upstream Fast denial.
    if(accessObject&&confirmations.length===0){
      // The current composer gets its tier decision from the shared access
      // mapper, with no request-time callback. Keep that server result as the
      // entitlement source and extend only the explicit local API-key gate.
      let accessMapper=functions.find(fn=>functionName(fn)===mapper)
      if(!accessMapper){
        const references=nodes(program,n=>n.type==='ImportDeclaration'&&n.specifiers.some((specifier:Node)=>specifier.local?.name===mapper))
        const reference=one<Node>(references),specifier=one<Node>(reference.specifiers.filter((item:Node)=>item.local?.name===mapper))
        const external=importedModules[reference.source.value]
        if(!external||typeof specifier.imported?.name!=='string')throw new Error('missing imported access mapper')
        const externalProgram=parse(external,{ecmaVersion:'latest',sourceType:'module'}) as Node
        const importedName=specifier.imported.name as string
        const exportedNodes=nodes(externalProgram,n=>n.type==='ExportNamedDeclaration'&&n.source==null&&n.specifiers?.some((item:Node)=>item.exported?.name===specifier.imported.name))
        const directDeclarations=(externalProgram.body as Node[]).filter(node=>node.type==='ExportNamedDeclaration'&&node.declaration?.id?.name===importedName)
        const exportCount=exportedNodes.reduce((count:number,declaration:Node)=>count+declaration.specifiers.filter((item:Node)=>item.exported?.name===importedName).length,0)+directDeclarations.length
        if(exportCount!==1)throw new Error('ambiguous exported access mapper')
        const localName=directDeclarations.length?importedName:one<Node>(exportedNodes.flatMap((declaration:Node)=>declaration.specifiers.filter((item:Node)=>item.exported?.name===importedName))).local?.name
        accessMapper=one(moduleFunctions(externalProgram).filter(fn=>functionName(fn)===localName))
      }
      const mapperInput=accessMapper.params?.[0]?.type==='Identifier'?accessMapper.params[0].name:undefined
      if(!mapperInput||accessMapper.params.length!==1)throw new Error('access mapper input contract')
      const returns=nodes(accessMapper,n=>n.type==='ReturnStatement'&&n.argument?.type==='ObjectExpression')
      const result=one(returns).argument
      const fastValue=one<Node>(result.properties.filter((item:Node)=>item.type==='Property'&&item.key?.name==='fast')).value
      const ultraValue=one<Node>(result.properties.filter((item:Node)=>item.type==='Property'&&item.key?.name==='ultrafast')).value
      const resolveMode=(value:Node,mode:string,seen=new Set<string>()):boolean=>{
        value=unwrap(value)
        if(value.type==='Identifier'){
          if(seen.has(value.name))return false
          seen.add(value.name)
          const declarations=nodes(accessMapper,n=>n.type==='VariableDeclarator'&&n.id?.type==='Identifier'&&n.id.name===value.name)
          return declarations.length===1&&!!declarations[0].init&&resolveMode(declarations[0].init,mode,seen)
        }
        return value.type==='BinaryExpression'&&value.operator==='!=='&&booleanLiteral(value.right)===false&&resolvedMemberPath(value.left,accessMapper).join('.')===`${mapperInput}.requirements.featureRequirements.${mode}`
      }
      if(!resolveMode(fastValue,'fast_mode')||ultraValue.type!=='LogicalExpression'||ultraValue.operator!=='&&'||!resolveMode(ultraValue.right,'ultrafast_mode'))throw new Error('access mapper entitlement result')
      const fastName=fastValue.type==='Identifier'?fastValue.name:undefined,left=ultraValue.left
      const independentValues=nodes(left,n=>n.type==='BinaryExpression'&&n.operator==='==='&&((resolvedMemberPath(n.left,accessMapper).join('.')===`${mapperInput}.supportsIndependentSpeedModes`&&booleanLiteral(n.right)===true)||(resolvedMemberPath(n.right,accessMapper).join('.')===`${mapperInput}.supportsIndependentSpeedModes`&&booleanLiteral(n.left)===true)))
      if(!fastName||left.type!=='LogicalExpression'||left.operator!=='||'||!nodes(left,n=>n.type==='Identifier'&&n.name===fastName).length||independentValues.length!==1)throw new Error('independent Ultra Fast entitlement')
      const uiName=functionName(ui)
      if(!uiName)throw new Error('access UI binding')
      const providers=functions.filter(fn=>fn!==ui&&['serviceTierSettings','availableOptions','setServiceTier'].every(term=>text(fn).includes(term))&&nodes(fn,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name===uiName).length===1&&nodes(fn,n=>n.type==='Property'&&n.key?.name===capability).length>=1)
      const provider=one(providers)
      if(!functionName(provider))throw new Error('access consumer contract')
      const verifiedLocalApi=`${host}===\`local\`&&(${account}?.authMethod===\`apikey\`||${account}?.authMethod===null&&${account}?.requiresAuth===!1)`
      const edits=[edit(auth.init,`${text(auth.init)}||${verifiedLocalApi}`),edit(queryPending,`${text(queryPending)}&&!(${custom})`),edit(needsData,`(${text(needsData)}||(${custom}))`)]
      if(accessCall)edits.push(edit(accessCall.arguments[0],`${data}??{requirements:{featureRequirements:{fast_mode:!0,ultrafast_mode:!1}}}`))
      return edits
    }
    const controls=one(functionsWith(capability,'serviceTierSettings','availableOptions','setServiceTier'))
    const controlQuery=one(nodes(controls,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='isPending')))
    const controlPending=one<Node>(controlQuery.id.properties.filter((p:Node)=>p.key.name==='isPending')).value.name
    const controlIdentity=one(nodes(controls,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name===capability)))
    const permitted=one<Node>(controlIdentity.id.properties.filter((p:Node)=>p.key.name===capability&&p.value.type==='Identifier')).value.name
    const controlLoading=one(nodes(controls,n=>n.type==='LogicalExpression'&&n.operator==='&&'&&n.right.name===controlPending&&n.left.type==='BinaryExpression'&&n.left.operator==='=='&&literal(n.left.right)===null))
    const confirm=one(confirmations)
    const denied=accessObject?'null':'!1'
    const guard=one(nodes(confirm,n=>n.type==='IfStatement'&&n.consequent.type==='ReturnStatement'&&text(n.test).includes('chatgpt')&&text(n.consequent.argument)===denied))
    const method=one(nodes(guard.test,n=>n.type==='BinaryExpression'&&literal(n.right)==='chatgpt'&&n.left.type==='Identifier')).left.name
    // Replace only the known identity guard. A future business restriction in
    // this condition must disable the patch instead of being silently removed.
    const guardTerms=[guard.test.left,guard.test.right] as Node[]
    if(guard.alternate||guard.test.type!=='LogicalExpression'||guard.test.operator!=='&&'||guardTerms.some(term=>term.type!=='BinaryExpression'||term.operator!=='!=='||term.left.type!=='Identifier'||term.left.name!==method)||new Set(guardTerms.map(term=>literal(term.right))).size!==2||guardTerms.some(term=>!['chatgpt','personalAccessToken'].includes(literal(term.right) as string)))throw new Error('auth guard contract')
    const methodRead=one(nodes(confirm,n=>n.type==='VariableDeclarator'&&n.id.name===method&&n.init?.type==='AwaitExpression')).init.argument
    if(methodRead.type!=='CallExpression'||methodRead.callee.type!=='Identifier'||methodRead.arguments.length!==2||methodRead.arguments.some((a:Node)=>a.type!=='Identifier'))throw new Error('auth reader')
    const helper=one(functions.filter(fn=>functionName(fn)===methodRead.callee.name))
    const rpc=one(nodes(helper,n=>n.type==='CallExpression'&&property(unwrap(n.callee))==='getAccount'))
    const receiver=unwrap(rpc.callee).object
    if(property(receiver)!=='rpc'||receiver.object.type!=='Identifier')throw new Error('account RPC')
    const accessor=one(nodes(helper,n=>n.type==='VariableDeclarator'&&n.id.name===receiver.object.name&&n.init?.type==='CallExpression')).init
    const wrapper=one(nodes(helper,n=>n.type==='CallExpression'&&n.arguments.length===1&&n.arguments[0]===rpc))
    if(wrapper.callee.type!=='Identifier'||accessor.arguments.length!==2)throw new Error('account reader')
    const [scopeId,hostId]=methodRead.arguments.map((n:Node)=>n.name)
    if(property(accessor.callee)!=='get'||accessor.callee.object?.name!==helper.params[0]?.name||accessor.arguments[0].type!=='Identifier'||accessor.arguments[1].name!==helper.params[1]?.name)throw new Error('account scope')
    // These module bindings are copied into a different function. Refuse local
    // aliases or shadowing rather than emitting a reference outside its scope.
    const helperBindings=localBindings(helper),confirmBindings=localBindings(confirm),bindings=[...helperBindings,...confirmBindings]
    if([accessor.arguments[0].name,wrapper.callee.name].some(name=>bindings.includes(name))||confirmBindings.has(methodRead.callee.name))throw new Error('account reader binding scope')
    const call=`${text(wrapper.callee)}(${scopeId}.get(${text(accessor.arguments[0])},${hostId})?.rpc.getAccount({priority:\`critical\`}))`
    const fallback=`if(${method}!==\`chatgpt\`&&${method}!==\`personalAccessToken\`&&${method}!==\`apikey\`){if(${method}!==null||${hostId}!==\`local\`)return ${denied};let __cmlAccount;try{__cmlAccount=await ${call}}catch{return ${denied}}if(__cmlAccount?.account!==null||__cmlAccount?.requiresOpenaiAuth!==!1)return ${denied};}`
    const requirements=one(nodes(confirm,n=>n.type==='AwaitExpression'&&n.argument.type==='CallExpression'&&n.argument!==methodRead))
    const optionalRequirements=`await ${text(requirements.argument)}.catch(__cmlError=>{if(${hostId}===\`local\`&&(${method}===\`apikey\`||${method}===null))return {requirements:null};throw __cmlError})`
    // Signed-in requirements do not exist for custom API providers. Preserve
    // their explicit Fast denial when present, without waiting indefinitely
    // for an unrelated ChatGPT workspace request. Null identities were verified
    // through account/read above before this request-time fallback is reached.
    return [edit(auth.init,`${text(auth.init)}||${account}?.authMethod===\`apikey\`||${host}===\`local\`&&${account}?.authMethod===null&&${account}?.requiresAuth===!1`),edit(queryPending,`${text(queryPending)}&&!(${custom})`),edit(needsData,`(${text(needsData)}||(${custom}))`),edit(controlLoading,`${text(controlLoading)}&&${accessObject?`${permitted}==null`:`!${permitted}`}`),edit(guard,fallback),edit(requirements,optionalRequirements),...(access?[edit(access.consequent.arguments[0],`${data}??{requirements:null}`)]:[])]
  })
  transaction('ultra',()=>{
    // Lazy module initializers can nest the settings atom in several callbacks.
    // Match the unique Set expression itself: wrapper/function ownership is a
    // bundler detail, and no bindings move across scopes in this edit.
    const values=one(functions.flatMap(fn=>nodes(fn,n=>n.type==='NewExpression'&&n.callee.name==='Set'&&n.arguments.length===1&&n.arguments[0].type==='ArrayExpression'&&n.arguments[0].elements.some((e:Node)=>e?.type==='SpreadElement'&&nodes(e,n=>property(n)==='enabledReasoningEfforts').length===1)&&n.arguments[0].elements.some((e:Node)=>literal(e)==='persistent')))).arguments[0]
    const levels=values.elements.some((e:Node)=>literal(e)==='ultra')?[]:[edit(values,text(values).slice(0,-1)+',`ultra`]')]
    const catalogue=one(functionsWith('includeUltraReasoningEffort','hasModelSupportingUltraReasoningEffort','supportedReasoningEfforts.filter'))
    const availability=one(nodes(catalogue,n=>n.type==='VariableDeclarator'&&n.init?.type==='LogicalExpression'&&n.init.operator==='&&'&&text(n.init.right).includes('supportedReasoningEfforts')&&text(n.init.right).includes('ultra'))).init
    const filtered=one(nodes(catalogue,n=>n.type==='ConditionalExpression'&&property(n.consequent)==='supportedReasoningEfforts'&&text(n.alternate).includes('supportedReasoningEfforts.filter')&&text(n.alternate).includes('ultra')))
    const gates:Node[]=[]
    // Persistence mutations also live inside lazy initializer callbacks. Include
    // those owned calls once without requiring their owner to be module-level.
    for(const fn of functions.filter(fn=>['536305374','ultra'].every(term=>text(fn).includes(term))&&['thinkingEffort','reasoningEffort','includeUltraReasoningEffort'].some(term=>text(fn).includes(term))))
      gates.push(...nodes(fn,n=>n.type==='CallExpression'&&n.arguments.length===2&&literal(n.arguments[1])==='536305374'&&(n.callee.type==='Identifier'||property(n.callee)==='get')))
    const unique=[...new Map(gates.map(n=>[n.start,n])).values()]
    if(unique.length<3||unique.length>12)throw new Error('ultra persistence roles')
    return [...levels,edit(availability,text(availability.right)),edit(filtered,text(filtered.consequent)),...unique.map(gate=>edit(gate,'!0'))]
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
