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
  // Collect the top-level function bindings of one lexical scope — Program, or a
  // bundler module factory body (see rspackModuleScopes). A nested helper is
  // never promoted here; detectors treat it as part of its owner.
  const scope=(body:readonly Node[]|undefined)=>{
    for(const node of body??[]){
      if(node.type==='FunctionDeclaration'){
        if(node.id?.type==='Identifier')add(node,node.id.name)
        continue
      }
      if(node.type==='VariableDeclaration'){
        for(const declaration of node.declarations??[]){
          if(declaration.id?.type==='Identifier'&&isFunction(declaration.init))add(declaration.init,declaration.id.name)
        }
        continue
      }
      // A module export still binds its declaration at Program scope.
      if(['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(node.type)&&node.declaration){
        if(node.declaration.type==='FunctionDeclaration'){if(node.declaration.id?.type==='Identifier')add(node.declaration,node.declaration.id.name)}
        else if(node.declaration.type==='VariableDeclaration')for(const declaration of node.declaration.declarations??[])if(declaration.id?.type==='Identifier'&&isFunction(declaration.init))add(declaration.init,declaration.id.name)
      }
    }
  }
  const factories=rspackModuleFactories(program)
  if(factories.length)for(const factory of factories)scope(factory.body?.body)
  else scope(program.body)
  // Rspack module source exports some semantic roles as direct values inside
  // `d(exports, {}, {name: function(){...}})` rather than local bindings.
  // Only direct export values are promoted; nested callbacks stay owned.
  if(!factories.length)for(const statement of program.body??[])visit(statement,node=>{
    if(node.type!=='CallExpression'||property(node.callee)!=='d')return
    for(const object of node.arguments.slice(1).filter((argument:Node)=>argument.type==='ObjectExpression'))
      for(const entry of object.properties??[]){
        const value=entry.type==='Property'?entry.value:undefined
        if(isFunction(value))add(value,entry.key?.name??String(entry.key?.value??''))
      }
  })
  return functions
}

/**
 * rspack/webpack split the renderer into a `__webpack_modules__` object whose
 * values are per-module factory functions `id(e,t,r){...}`. Each factory body
 * is the real module scope; the Program body holds only the registration
 * wrapper. Return those factory functions so the single-file and bundled
 * layouts share one notion of "module scope". Empty for a classic single file.
 */
function rspackModuleEntries(program:Node):{id:string;factory:Node}[] {
  const factories:{id:string;factory:Node}[]=[]
  const fromObject=(object:Node|undefined)=>{
    if(object?.type!=='ObjectExpression')return
    for(const property of object.properties??[]){
      const value=property.type==='Property'?(property.value??(property.method?property.value:undefined)):undefined
      const id=property.key?.type==='Literal'?String(property.key.value):property.key?.name
      if(isFunction(value)&&typeof id==='string')factories.push({id,factory:value})
    }
  }
  const scan=(node:Node|undefined)=>{
    if(!node)return
    const declaration=['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(node.type)?node.declaration:node
    if(declaration?.type==='VariableDeclaration')for(const item of declaration.declarations??[]){
      if(item.id?.type==='Identifier'&&item.id.name==='__webpack_modules__')fromObject(item.init)
    }
  }
  for(const node of program.body??[])scan(node)
  return factories
}
function rspackModuleFactories(program:Node):Node[]{return rspackModuleEntries(program).map(entry=>entry.factory)}
export interface CodexUiRspackModule {id:string;start:number;end:number;source:string}
export function codexUiRspackModules(source:string):CodexUiRspackModule[] {
  try{
    const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node
    return rspackModuleEntries(program).flatMap(({id,factory})=>factory.body?.type==='BlockStatement'?[{id,start:factory.body.start+1,end:factory.body.end-1,source:source.slice(factory.body.start+1,factory.body.end-1)}]:[])
  }catch{return []}
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

// The rspack module id of the access mapper the speed UI calls as
// `(0,ns.member)(data)` with `ns = require(id)`. Lets the caller fetch that
// module's chunk across the graph and supply it to detectCodexUiCapabilities as
// importedModules[id]. Undefined when the page is single-file or the UI is absent.
export function codexUiRspackMapperModule(source:string):string|undefined {
  try{
    const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node
    const functions=moduleFunctions(program)
    const uiCandidates=functions.filter(fn=>textOf(source,fn).includes('authMethod')&&textOf(source,fn).includes('isLoading')&&nodes(fn,n=>n.type==='Property'&&n.key?.name==='serviceTierAccess').length===1)
    const ui=one(uiCandidates.filter(fn=>{
      const query=nodes(fn,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending'))
      if(query.length!==1)return false
      const data=query[0].id.properties.find((p:Node)=>p.key.name==='data')?.value?.name
      return nodes(fn,n=>accessMapperCall(n,data)).length===1
    }))
    const query=one(nodes(ui,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending')))
    const data=one<Node>(query.id.properties.filter((p:Node)=>p.key.name==='data')).value.name
    const call=one(nodes(ui,n=>accessMapperCall(n,data)))
    const callee=mapperCallee(call)
    if(callee?.type!=='MemberExpression')return undefined
    return rspackRequireId(enclosingScope(program,ui),callee.object?.name)
  }catch{return undefined}
}

export function codexUiStaticImports(source:string):string[] {
  try{const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node;return (program.body as Node[]).filter(node=>node.type==='ImportDeclaration'&&typeof node.source?.value==='string').map(node=>node.source.value as string)}catch{return []}
}
export function codexUiDynamicImports(source:string):string[] {
  try{const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,result:string[]=[];visit(program,node=>{if(node.type==='ImportExpression'&&typeof literal(node.source)==='string')result.push(literal(node.source) as string)});return result}catch{return []}
}
export function codexUiLocaleProviderSupported(runtime:string,path:string,providerSource:string):boolean {
  try{
    // Most reachable chunks are unrelated to translation. Avoid parsing their
    // (potentially large) importer for each edge in the startup module graph.
    if(!['locale_source','enable_i18n','systemLocale','ideLocale','Failed to load locale messages'].every(term=>providerSource.includes(term)))return false
    const runtimeProgram=parse(runtime,{ecmaVersion:'latest',sourceType:'module'}) as Node
    if(!path.startsWith('./')||!path.endsWith('.js'))return false
    const imports=(runtimeProgram.body as Node[]).filter(node=>node.type==='ImportDeclaration'&&node.source?.value===path)
    if(!imports.length||!imports.some(declaration=>declaration.specifiers.some((specifier:Node)=>specifier.local?.name&&nodes(runtimeProgram,n=>n.type==='CallExpression'&&n.callee?.type==='Identifier'&&n.callee.name===specifier.local.name).length>0)))return false
    const provider=parse(providerSource,{ecmaVersion:'latest',sourceType:'module'}) as Node
    const detected=detectCodexUiCapabilities(providerSource)
    if(!detected.features.locale.supported||detected.replacements.locale.length!==2)return false
    const exportedNames=(provider.body as Node[]).flatMap(statement=>{
      if(statement.type!=='ExportNamedDeclaration'||statement.source!=null)return []
      const names:string[]=[]
      if(statement.declaration?.id?.name)names.push(statement.declaration.id.name)
      for(const specifier of statement.specifiers??[])if(specifier.local?.name)names.push(specifier.exported?.name)
      return names
    })
    const importedNames=imports.flatMap(declaration=>declaration.specifiers.filter((specifier:Node)=>{
      if(!specifier.local?.name)return false
      const calls=nodes(runtimeProgram,node=>node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name===specifier.local.name)
      return calls.length>0
    }).map((specifier:Node)=>specifier.imported?.name??specifier.local?.name))
    return exportedNames.some(name=>importedNames.includes(name))
  }catch{return false}
}
function textOf(source:string,node:Node):string{return source.slice(node.start,node.end)}
// The access mapper is invoked as `fn(data)` in single-file builds and as the
// Babel/rspack interop form `(0,ns.member)(data)` once bundled. Accept either
// so detection does not depend on the bundler's call shape.
function mapperCallee(node:Node|undefined):Node|undefined {
  if(node?.type!=='CallExpression'||node.arguments?.length!==1)return undefined
  const callee=unwrap(node.callee)
  if(callee.type==='Identifier')return callee
  // `(0,ns.member)` parses as a SequenceExpression whose final element is the
  // member read; the leading `0` is the interop `this`-stripping convention.
  if(callee.type==='SequenceExpression'&&callee.expressions.length===2){
    const last=unwrap(callee.expressions[1])
    if(last.type==='MemberExpression'&&!last.computed&&last.object?.type==='Identifier')return last
  }
  return undefined
}
function accessMapperCall(node:Node,argName:string|undefined):boolean {
  const callee=mapperCallee(node)
  return !!callee&&argName!==undefined&&unwrap((node as Node).arguments[0])?.name===argName
}
// Return the rspack module id a namespace identifier is bound to, i.e. the
// string literal in `ns = require("id")` (require minified to any single name).
function rspackRequireId(scope:Node,namespace:string|undefined):string|undefined {
  if(!namespace)return undefined
  // The namespace binding (`r = require("id")`) lives in the UI's own module
  // factory. Minified names like `r` are reused across factories, so search the
  // enclosing scope, not the whole chunk, to keep the binding unambiguous.
  const bindings=nodes(scope,n=>n.type==='VariableDeclarator'&&n.id?.type==='Identifier'&&n.id.name===namespace&&n.init?.type==='CallExpression'&&n.init.arguments?.length===1&&typeof literal(n.init.arguments[0])==='string')
  if(bindings.length!==1)return undefined
  return literal(bindings[0].init.arguments[0]) as string
}
// The smallest module factory body (rspack) or Program that encloses a node.
function enclosingScope(program:Node,node:Node):Node {
  const factories=rspackModuleFactories(program).filter(factory=>factory.start<=node.start&&factory.end>=node.end)
  return factories.sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0]??program
}
// The rspack module id + export name a function is published under, from its
// enclosing factory's `d(t,{export:()=>localFn})` table and the factory's key
// in __webpack_modules__. Lets a consumer reference be matched across factories
// through the `(0,require(id).export)()` interop call. Undefined for single file.
function moduleExportRef(program:Node,fn:Node):{moduleId:string;exportName:string}|undefined {
  const fnName=functionName(fn)
  for(const node of program.body??[]){
    const declaration=['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(node.type)?node.declaration:node
    if(declaration?.type!=='VariableDeclaration')continue
    for(const item of declaration.declarations??[]){
      if(item.id?.name!=='__webpack_modules__'||item.init?.type!=='ObjectExpression')continue
      for(const factory of item.init.properties){
        if(factory.type!=='Property'||!isFunction(factory.value)||factory.value.start>fn.start||factory.value.end<fn.end)continue
        const moduleId=factory.key.type==='Literal'?String(factory.key.value):factory.key.name
        const exports=nodes(factory.value,n=>n.type==='CallExpression'&&property(unwrap(n.callee))==='d'&&n.arguments?.length>=2&&n.arguments[1].type==='ObjectExpression').flatMap(call=>call.arguments[1].properties)
        const match=exports.filter((p:Node)=>p.type==='Property'&&p.value?.type==='ArrowFunctionExpression'&&p.value.body?.type==='Identifier'&&p.value.body.name===fnName)
        if(match.length===1&&typeof moduleId==='string')return {moduleId,exportName:match[0].key?.name}
      }
    }
  }
  return undefined
}
// The called target of any CallExpression, unwrapping the `(0,ns.member)`
// interop sequence — independent of argument count (unlike mapperCallee, which
// is specific to the single-argument access-mapper call).
function callTarget(node:Node):Node|undefined {
  if(node.type!=='CallExpression')return undefined
  const callee=unwrap(node.callee)
  if(callee.type==='Identifier')return callee
  if(callee.type==='SequenceExpression'&&callee.expressions.length===2){
    const last=unwrap(callee.expressions[1])
    if(last.type==='MemberExpression'&&!last.computed&&last.object?.type==='Identifier')return last
  }
  return undefined
}
// True when `node` calls `fn` either directly by name, or through the rspack
// interop form `(0,ns.export)()` where `ns = require(fn's module id)` in scope.
function callsUiFunction(node:Node,uiName:string|undefined,exportRef:{moduleId:string;exportName:string}|undefined,scope:Node):boolean {
  const callee=callTarget(node)
  if(callee?.type==='Identifier')return callee.name===uiName
  if(callee?.type==='MemberExpression'&&exportRef)return callee.property?.name===exportRef.exportName&&rspackRequireId(scope,callee.object?.name)===exportRef.moduleId
  return false
}
// Find the factory function body of a given module id inside a chunk's
// `__webpack_modules__` object (rspack inlines shared modules per chunk).
function rspackFactoryBody(program:Node,moduleId:string):Node|undefined {
  for(const node of program.body??[]){
    const declaration=['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(node.type)?node.declaration:node
    if(declaration?.type!=='VariableDeclaration')continue
    for(const item of declaration.declarations??[]){
      if(item.id?.name!=='__webpack_modules__'||item.init?.type!=='ObjectExpression')continue
      for(const property of item.init.properties){
        if(property.type!=='Property')continue
        const key=property.key.type==='Literal'?String(property.key.value):property.key.name
        if(key===moduleId&&isFunction(property.value))return property.value
      }
    }
  }
  return undefined
}
// Resolve the access mapper when the composer calls `(0,ns.member)(data)` and
// `ns = require("id")`. The id's module lives in another chunk whose source the
// caller supplies in importedModules. rspack exports members through
// `n.d(exports,{member:()=>localFn})`; bind that member back to its function.
function resolveRspackMapper(scope:Node,namespace:string|undefined,member:string|undefined,importedModules:Readonly<Record<string,string>>):Node|undefined {
  if(!namespace||!member)return undefined
  const moduleId=rspackRequireId(scope,namespace)
  if(!moduleId)return undefined
  const external=importedModules[moduleId]
  if(!external)throw new Error('missing imported access mapper')
  const externalProgram=parse(external,{ecmaVersion:'latest',sourceType:'module'}) as Node
  const factory=rspackFactoryBody(externalProgram,moduleId)
  if(!factory)throw new Error('access mapper module not found')
  // Export table: `d(t,{member:()=>localFn,…})`.
  const exportArgs=nodes(factory,n=>n.type==='CallExpression'&&property(unwrap(n.callee))==='d'&&n.arguments?.length>=2).flatMap(call=>call.arguments.slice(1).filter((argument:Node)=>argument.type==='ObjectExpression').flatMap((argument:Node)=>argument.properties))
  const entries=exportArgs.filter((p:Node)=>p.type==='Property'&&(p.key?.name??p.key?.value)===member&&(isFunction(p.value)||p.value?.type==='ArrowFunctionExpression'&&p.value.body?.type==='Identifier'))
  if(entries.length!==1)throw new Error('ambiguous exported access mapper')
  if(['FunctionExpression','FunctionDeclaration'].includes(entries[0].value?.type)&&entries[0].value.body?.type==='BlockStatement')return entries[0].value
  const localName=entries[0].value.body.name
  const body=factory.body?.body??[]
  const found=body.filter((n:Node)=>n.type==='FunctionDeclaration'&&n.id?.name===localName).concat(
    body.filter((n:Node)=>n.type==='VariableDeclaration').flatMap((n:Node)=>n.declarations).filter((d:Node)=>d.id?.name===localName&&isFunction(d.init)).map((d:Node)=>{d.init.__cmlBindingName=localName;return d.init}))
  return found.length===1?found[0]:undefined
}

function rspackRequirementsMapperSupported(mapper:Node):boolean {
  const input=mapper.params?.[0]?.type==='Identifier'?mapper.params[0].name:undefined
  if(!input||mapper.params.length!==1)return false
  const returns=nodes(mapper,node=>node.type==='ReturnStatement'&&node.argument?.type==='ObjectExpression')
  if(returns.length!==1)return false
  const properties=returns[0].argument.properties,fast=properties.filter((item:Node)=>item.type==='Property'&&item.key?.name==='fast'),ultra=properties.filter((item:Node)=>item.type==='Property'&&item.key?.name==='ultrafast')
  if(fast.length!==1||ultra.length!==1)return false
  const resolveMode=(value:Node,mode:string,seen=new Set<string>()):boolean=>{
    value=unwrap(value)
    if(value.type==='Identifier'){
      if(seen.has(value.name))return false
      seen.add(value.name)
      const declarations=nodes(mapper,node=>node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.id.name===value.name)
      return declarations.length===1&&!!declarations[0].init&&resolveMode(declarations[0].init,mode,seen)
    }
    return value.type==='BinaryExpression'&&value.operator==='!=='&&booleanLiteral(value.right)===false&&resolvedMemberPath(value.left,mapper).join('.')===`${input}.requirements.featureRequirements.${mode}`
  }
  const fastValue=fast[0].value,ultraValue=unwrap(ultra[0].value),fastName=fastValue.type==='Identifier'?fastValue.name:undefined
  if(!fastName||!resolveMode(fastValue,'fast_mode'))return false
  const independentCheck=(scope:Node)=>nodes(scope,node=>node.type==='BinaryExpression'&&node.operator==='==='&&((resolvedMemberPath(node.left,mapper).join('.')===`${input}.supportsIndependentSpeedModes`&&booleanLiteral(node.right)===true)||(resolvedMemberPath(node.right,mapper).join('.')===`${input}.supportsIndependentSpeedModes`&&booleanLiteral(node.left)===true))).length===1
  if(ultraValue.type==='LogicalExpression'&&ultraValue.operator==='&&'){
    const left=ultraValue.left
    return resolveMode(ultraValue.right,'ultrafast_mode')&&left.type==='LogicalExpression'&&left.operator==='||'&&nodes(left,node=>node.type==='Identifier'&&node.name===fastName).length>0&&independentCheck(left)
  }
  if(ultraValue.type==='ConditionalExpression'){
    const alternate=unwrap(ultraValue.alternate),test=unwrap(ultraValue.test)
    const ownPropertyGuard=nodes(test,node=>node.type==='BinaryExpression'&&node.operator==='in'&&literal(node.left)==='supportsIndependentSpeedModes'&&node.right?.name===input).length===1
    return (independentCheck(test)||ownPropertyGuard)&&resolveMode(ultraValue.consequent,'ultrafast_mode')&&alternate.type==='LogicalExpression'&&alternate.operator==='&&'&&nodes(alternate,node=>node.type==='Identifier'&&node.name===fastName).length>0&&resolveMode(alternate.right,'ultrafast_mode')
  }
  return false
}

export function codexUiRspackServiceTierMapperModule(source:string):string|undefined {
  try{
    const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,functions=moduleFunctions(program),matches=new Set<string>()
    for(const hook of functions){
      const body=textOf(source,hook)
      if(!['serviceTierAccess','isPending','amazonBedrock','personalAccessToken'].every(term=>body.includes(term)))continue
      for(const call of nodes(hook,node=>node.type==='CallExpression'&&node.arguments?.length===1&&node.arguments[0]?.type==='Identifier')){
        const callee=mapperCallee(call)
        if(callee?.type!=='MemberExpression'||callee.property?.name!=='W6'||callee.object?.type!=='Identifier')continue
        const id=rspackRequireId(program,callee.object.name)
        if(id)matches.add(id)
      }
    }
    return matches.size===1?[...matches][0]:undefined
  }catch{return undefined}
}

export function codexUiRspackHasServiceTierConsumer(source:string,providerModuleId:string):boolean {
  return codexUiRspackModules(source).some(module=>module.source.includes(`("${providerModuleId}")`)&&['serviceTierAccess','serviceTierSettings','availableOptions','setServiceTier'].every(term=>module.source.includes(term)))
}

export function codexUiRspackServiceTierHookReplacements(source:string,importedModules:Readonly<Record<string,string>>):CodexUiReplacement[] {
  const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,functions=moduleFunctions(program),text=(node:Node)=>textOf(source,node)
  const unique=<T>(values:readonly T[],role:string):T=>{if(values.length!==1)throw new Error(`Rspack ${role} role count ${values.length}`);return values[0]}
  const edit=(node:Node,after:string):CodexUiReplacement=>({begin:'',end:'',before:text(node),after,offset:node.start})
  const hook=unique(functions.filter(fn=>['serviceTierAccess','isPending','amazonBedrock','personalAccessToken'].every(term=>text(fn).includes(term))),'service-tier hook')
  const queries=nodes(hook,node=>node.type==='VariableDeclarator'&&node.id?.type==='ObjectPattern'&&node.id.properties.some((item:Node)=>item.key?.name==='data')&&node.id.properties.some((item:Node)=>item.key?.name==='isPending'))
  const query=unique(queries,'requirements query'),dataName=query.id.properties.find((item:Node)=>item.key?.name==='data')?.value?.name,pendingName=query.id.properties.find((item:Node)=>item.key?.name==='isPending')?.value?.name
  if(!dataName||!pendingName)throw new Error('Rspack requirements query binding')
  const mapperCalls=nodes(hook,node=>accessMapperCall(node,dataName)).filter(node=>mapperCallee(node)?.type==='MemberExpression')
  const mapperCall=unique(mapperCalls,'requirements mapper call'),mapperCalleeNode=mapperCallee(mapperCall)!
  if(mapperCalleeNode.property?.name!=='W6'||mapperCalleeNode.object?.type!=='Identifier')throw new Error('Rspack requirements mapper export')
  const mapperModuleId=rspackRequireId(program,mapperCalleeNode.object.name),mapper=resolveRspackMapper(program,mapperCalleeNode.object.name,'W6',importedModules)
  if(!mapperModuleId||!mapper||!rspackRequirementsMapperSupported(mapper))throw new Error('Rspack Fast/Ultra-Fast entitlement contract')
  const gate=unique(nodes(hook,node=>node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init&&['chatgpt','personalAccessToken','amazonBedrock'].every(method=>nodes(node.init,(child:Node)=>child.type==='BinaryExpression'&&child.operator==='==='&&literal(child.right)===method).length>0)),'account gate')
  const comparisons=nodes(gate.init,node=>node.type==='BinaryExpression'&&node.operator==='==='&&typeof literal(node.right)==='string'&&['chatgpt','personalAccessToken','amazonBedrock'].includes(literal(node.right) as string))
  if(comparisons.length!==3)throw new Error('Rspack account gate contract')
  const authPaths=comparisons.map(node=>memberPath(node.left).join('.'))
  if(!authPaths[0]?.endsWith('.authMethod')||!authPaths.every(path=>path===authPaths[0]))throw new Error('Rspack account identity binding')
  const identityName=authPaths[0].split('.')[0],hostRead=unique(nodes(hook,node=>node.type==='MemberExpression'&&property(node)==='hostId'&&node.object?.name===hook.params?.[0]?.name),'host scope')
  const hostBinding=unique(nodes(hook,node=>node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init&&nodes(node.init,child=>child===hostRead).length===1),'host binding'),hostName=hostBinding.id.name
  const identityRead=unique(nodes(hook,node=>node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init?.type==='CallExpression'&&node.init.arguments?.some((arg:Node)=>arg.type==='Identifier'&&arg.name===hostName)&&property(callTarget(node.init)??undefined)==='tn'),'account reader')
  if(identityRead.id.name!==identityName)throw new Error('Rspack account identity scope')
  const loading=unique(nodes(hook,node=>node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init?.type==='LogicalExpression'&&node.init.operator==='||'&&nodes(node.init,child=>child.type==='MemberExpression'&&property(child)==='isLoading'&&memberPath(child).join('.')===`${identityName}.isLoading`).length===1&&nodes(node.init,child=>child.type==='LogicalExpression'&&child.operator==='&&'&&child.left?.name===gate.id.name&&child.right?.name===pendingName).length===1),'requirements loading gate')
  const access=unique(nodes(hook,node=>node.type==='ConditionalExpression'&&nodes(node,child=>child===mapperCall).length===1&&literal(node.alternate)===null),'access result'),test=access.test
  const hasIdentity=nodes(test,node=>node.type==='Identifier'&&node.name===gate.id.name).length>0,hasLoading=nodes(test,node=>node.type==='Identifier'&&node.name===loading.id.name).length>0,hasDataCheck=nodes(test,node=>node.type==='BinaryExpression'&&['!=','!=='].includes(node.operator)&&((node.left?.name===dataName&&literal(node.right)===null)||(node.right?.name===dataName&&literal(node.left)===null))).length===1
  if(!hasIdentity||!hasLoading||!hasDataCheck)throw new Error('Rspack access gate contract')
  const localApi=`${hostName}===\`local\`&&(${identityName}?.authMethod===\`apikey\`||${identityName}?.authMethod===null&&${identityName}?.requiresAuth===!1)`
  const pendingGate=unique(nodes(loading.init,node=>node.type==='LogicalExpression'&&node.operator==='&&'&&node.left?.name===gate.id.name&&node.right?.name===pendingName),'pending query gate')
  return [
    edit(gate.init,`(${text(gate.init)})||(${localApi})`),
    edit(pendingGate,`${gate.id.name}&&!(${localApi})&&${pendingName}`),
    edit(test,`${gate.id.name}&&!${loading.id.name}&&(${dataName}!=null||${localApi})`),
    edit(mapperCall.arguments[0],`${dataName}??{requirements:{featureRequirements:{fast_mode:!0,ultrafast_mode:!1}},supportsIndependentSpeedModes:!1}`)
  ]
}

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
    const uiRoles=uiCandidates.filter(fn=>{
      if(!nodes(fn,n=>n.type==='Property'&&n.key.name==='serviceTierAccess').length)return true
      const queries=nodes(fn,n=>n.type==='VariableDeclarator'&&n.id.type==='ObjectPattern'&&n.id.properties.some((p:Node)=>p.key.name==='data')&&n.id.properties.some((p:Node)=>p.key.name==='isPending'))
      if(queries.length!==1)return false
      const dataName=queries[0].id.properties.find((p:Node)=>p.key.name==='data')?.value?.name
      return nodes(fn,n=>accessMapperCall(n,dataName)).length===1
    })
    const ui=one(uiRoles)
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
    // The data guard appears as `data!=null` or, after bundling, `null!=data`.
    const needsData=one(nodes(ui,n=>n.type==='BinaryExpression'&&n.operator==='!='&&((n.left.name===data&&literal(n.right)===null)||(n.right.name===data&&literal(n.left)===null))))
    const accessCall=accessObject?one(nodes(ui,n=>accessMapperCall(n,data))):undefined
    const accessCallee=accessCall?mapperCallee(accessCall):undefined
    // For `(0,ns.member)(data)` the mapper is the namespace member; for `fn(data)`
    // it is the identifier itself. Track both the local name and the member.
    const access=accessCallee?.type==='Identifier'?accessCallee.name:undefined
    const mapper=accessCallee?.type==='Identifier'?accessCallee.name:accessCallee?.object?.name
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
      // rspack form `(0,ns.member)(data)` resolves through the require binding
      // and export table — not by the namespace's local name, which is a reused
      // minified identifier that would otherwise collide with an unrelated
      // top-level function. Only the single-file `fn(data)` form binds by name.
      let accessMapper=accessCallee?.type==='MemberExpression'
        ? resolveRspackMapper(enclosingScope(program,ui),mapper,accessCallee.property?.name,importedModules)
        : functions.find(fn=>functionName(fn)===mapper)
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
      if(!accessMapper)throw new Error('missing access mapper')
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
      if(!resolveMode(fastValue,'fast_mode'))throw new Error('access mapper entitlement result')
      const fastName=fastValue.type==='Identifier'?fastValue.name:undefined
      if(!fastName)throw new Error('access mapper entitlement result')
      const independentCheck=(scope:Node):boolean=>nodes(scope,n=>n.type==='BinaryExpression'&&n.operator==='==='&&((resolvedMemberPath(n.left,accessMapper).join('.')===`${mapperInput}.supportsIndependentSpeedModes`&&booleanLiteral(n.right)===true)||(resolvedMemberPath(n.right,accessMapper).join('.')===`${mapperInput}.supportsIndependentSpeedModes`&&booleanLiteral(n.left)===true))).length===1
      // Ultra Fast stays gated by ultrafast_mode and (Fast || independent speed
      // modes). Bundlers emit this either as `(fast||independent)&&ultrafast` or
      // as the ternary `independent ? ultrafast : fast&&ultrafast`. Accept both
      // so the entitlement contract — never the syntax — is what is verified.
      if(ultraValue.type==='LogicalExpression'&&ultraValue.operator==='&&'){
        const left=ultraValue.left
        if(!resolveMode(ultraValue.right,'ultrafast_mode')||left.type!=='LogicalExpression'||left.operator!=='||'||!nodes(left,n=>n.type==='Identifier'&&n.name===fastName).length||!independentCheck(left))throw new Error('independent Ultra Fast entitlement')
      }else if(ultraValue.type==='ConditionalExpression'){
        const alternate=unwrap(ultraValue.alternate)
        if(!independentCheck(ultraValue.test)||!resolveMode(ultraValue.consequent,'ultrafast_mode')||alternate.type!=='LogicalExpression'||alternate.operator!=='&&'||!nodes(alternate,n=>n.type==='Identifier'&&n.name===fastName).length||!resolveMode(alternate.right,'ultrafast_mode'))throw new Error('independent Ultra Fast entitlement')
      }else throw new Error('independent Ultra Fast entitlement')
      const uiName=functionName(ui)
      if(!uiName)throw new Error('access UI binding')
      // Consumers call the UI either as `uiName(...)` or, once bundled, as the
      // export form `(0,require("id").export)()`. Match both so the consumer
      // sanity check holds across the single-file and rspack layouts.
      const uiExport=moduleExportRef(program,ui)
      const consumes=(fn:Node)=>nodes(fn,n=>callsUiFunction(n,uiName,uiExport,enclosingScope(program,fn))).length===1
      const providers=functions.filter(fn=>fn!==ui&&['serviceTierSettings','availableOptions','setServiceTier'].every(term=>text(fn).includes(term))&&consumes(fn)&&nodes(fn,n=>n.type==='Property'&&n.key?.name===capability).length>=1)
      // At least one named service-tier settings consumer must read this UI. The
      // composer inline menu and the settings panel are both legitimate
      // consumers in newer clients, so require one-or-more (all named) rather
      // than exactly one. This gate only confirms the UI; it drives no edit.
      if(!providers.length||!providers.every(fn=>functionName(fn)))throw new Error('access consumer contract')
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
    // rspack keeps the settings atom inside an inline arrow at the module
    // factory body, not in a top-level function. Search the whole factory body
    // in that layout; a classic single file keeps searching its module-scope
    // functions so existing bundles behave identically.
    const factories=rspackModuleFactories(program)
    const settingsRoots=factories.length?factories:functions
    const settingsSets=settingsRoots.flatMap(root=>nodes(root,n=>{
      if(n.type!=='NewExpression'||n.callee.name!=='Set'||n.arguments.length!==1)return false
      const value=n.arguments[0]
      if(value.type==='ArrayExpression')return value.elements.some((e:Node)=>e?.type==='SpreadElement'&&nodes(e,c=>property(c)==='enabledReasoningEfforts').length===1)&&value.elements.some((e:Node)=>literal(e)==='persistent')
      // Newer clients build the enabled set directly from the persisted setting:
      // `new Set(read(settings, …enabledReasoningEfforts))`. The call result is
      // the source of truth, so append ultra around that whole expression.
      if(value.type==='CallExpression')return nodes(value,c=>property(c)==='enabledReasoningEfforts').length===1&&nodes(value,c=>c.type==='NewExpression'&&c.callee?.name==='Set').length===0
      if(value.type!=='Identifier')return false
      const block=nodes(root,c=>c.type==='BlockStatement'&&c.start<value.start&&c.end>value.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0]
      if(!block)return false
      const declarations=(block.body as Node[]).filter(c=>c.type==='VariableDeclaration'&&c.end<n.start).flatMap(c=>c.declarations).filter(c=>c.id?.name===value.name)
      if(nodes(block,c=>c.type==='AssignmentExpression'&&c.left?.name===value.name||c.type==='UpdateExpression'&&c.argument?.name===value.name).length)return false
      return declarations.length===1&&declarations[0].init?.type==='CallExpression'&&nodes(declarations[0].init,c=>property(c)==='enabledReasoningEfforts').length===1
    }))
    const values=one(settingsSets).arguments[0]
    const levels=values.type==='ArrayExpression'&&values.elements.some((e:Node)=>literal(e)==='ultra')?[]:[edit(values,values.type==='ArrayExpression'?text(values).slice(0,-1)+',`ultra`]':`[...${text(values)},\`ultra\`]`)]
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

function rspackEdit(source:string,node:Node,after:string):CodexUiReplacement {
  return {begin:'',end:'',offset:node.start,before:source.slice(node.start,node.end),after}
}

/** Detect the locale provider inside one isolated Rspack module factory. */
export function codexUiRspackLocaleReplacements(source:string):CodexUiReplacement[] {
  const detected=detectCodexUiCapabilities(source)
  if(!detected.features.locale.supported||detected.replacements.locale.length!==2)throw new Error('Rspack locale provider contract')
  return detected.replacements.locale
}

/** Patch only the Ultra catalogue's global visibility gate and filter. Model
 * specific advertised reasoning efforts and enabled-level preferences remain
 * authoritative.
 */
export function codexUiRspackUltraCatalogueReplacements(source:string):CodexUiReplacement[] {
  const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,functions=moduleFunctions(program),text=(node:Node)=>source.slice(node.start,node.end)
  const catalogue=one(functions.filter(fn=>text(fn).includes('includeUltraReasoningEffort')&&text(fn).includes('hasModelSupportingUltraReasoningEffort')&&text(fn).includes('supportedReasoningEfforts')))
  const parameter=one<Node>(catalogue.params.flatMap((param:Node)=>param.type==='ObjectPattern'?param.properties:[]).filter((entry:Node)=>entry.key?.name==='includeUltraReasoningEffort'))
  const include=parameter.value?.type==='Identifier'?parameter.value.name:parameter.key?.name
  if(!include)throw new Error('Rspack Ultra catalogue input')
  const availability=one(nodes(catalogue,node=>node.type==='VariableDeclarator'&&node.init?.type==='LogicalExpression'&&node.init.operator==='&&'&&node.init.left?.name===include&&text(node.init.right).includes('supportedReasoningEfforts')&&text(node.init.right).includes('ultra')))
  const filtered=one(nodes(catalogue,node=>node.type==='ConditionalExpression'&&property(node.consequent)==='supportedReasoningEfforts'&&text(node.alternate).includes('supportedReasoningEfforts.filter')&&text(node.alternate).includes('ultra')))
  return [rspackEdit(source,availability.init,text(availability.init.right)),rspackEdit(source,filtered,text(filtered.consequent))]
}

/** Remove only persistence checks for the Ultra reasoning effort in the
 * module's reasoning update functions; keep the rest of each mutation intact.
 */
export function codexUiRspackUltraGateReplacements(source:string):CodexUiReplacement[] {
  const program=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as Node,functions=moduleFunctions(program),gates:Node[]=[]
  for(const fn of functions){
    const body=source.slice(fn.start,fn.end)
    if(!body.includes('536305374')||!body.includes('ultra')||!['thinkingEffort','reasoningEffort','includeUltraReasoningEffort'].some(term=>body.includes(term)))continue
    gates.push(...nodes(fn,node=>node.type==='CallExpression'&&node.arguments.length===2&&literal(node.arguments[1])==='536305374'&&(node.callee.type==='Identifier'||property(unwrap(node.callee))==='get')))
  }
  return [...new Map(gates.map(gate=>[gate.start,gate])).values()].map(gate=>rspackEdit(source,gate,'!0'))
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
