import {parse} from 'acorn'

type Node={type:string;[key:string]:any}
function nodes(root:Node,predicate:(node:Node)=>boolean):Node[]{
  const result:Node[]=[],pending=[root]
  while(pending.length){
    const node=pending.pop()!
    if(predicate(node))result.push(node)
    for(const value of Object.values(node)){
      if(value&&typeof value==='object'&&typeof value.type==='string')pending.push(value)
      else if(Array.isArray(value))for(const item of value)if(item&&typeof item.type==='string')pending.push(item)
    }
  }
  return result
}
const member=(node:Node|undefined,key:string)=>node?.type==='MemberExpression'&&!node.computed&&node.property?.name===key
const literal=(node:Node):unknown=>node.type==='Literal'?node.value:undefined

/** Count page-protocol registrations, excluding handlers on a proven separate
 * Electron session. New clients also register an app:// networking document in
 * a disposable fromPartition session; it cannot serve the desktop renderer. */
export function codexDesktopAppProtocolCount(source:string):number {
  const program=parse(source,{ecmaVersion:'latest',sourceType:'script'}) as Node
  let count=0
  const visit=(node:Node,scope:Node)=>{
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))scope=node
    if(node.type==='CallExpression'&&member(node.callee,'handle')&&member(node.callee.object,'protocol')){
      const scheme=node.arguments[0],value=scheme?.type==='TemplateLiteral'&&scheme.expressions.length===0?scheme.quasis[0].value.cooked:scheme&&literal(scheme)
      if(value==='app'){
        const receiver=node.callee.object.object
        const declarations=(scope.body?.body??[]).flatMap((statement:Node)=>statement.type==='VariableDeclaration'?statement.declarations:[])
          .filter((declaration:Node)=>receiver.type==='Identifier'&&declaration.id?.name===receiver.name)
        const init=declarations.length===1?declarations[0].init:undefined
        const isolated=init?.type==='CallExpression'&&member(init.callee,'fromPartition')&&member(init.callee.object,'session')&&
          !nodes(scope,n=>n.type==='AssignmentExpression'&&n.left?.name===receiver.name||n.type==='UpdateExpression'&&n.argument?.name===receiver.name).length
        if(!isolated)count++
      }
    }
    for(const value of Object.values(node)){
      if(value&&typeof value==='object'&&typeof value.type==='string')visit(value,scope)
      else if(Array.isArray(value))for(const child of value)if(child&&typeof child.type==='string')visit(child,scope)
    }
  }
  visit(program,program)
  return count
}

/** Read the bundler's chunk filename contract without executing client code.
 * Both CommonJS split entries and Webpack's static filename map are supported.
 * Paths, map size and expression forms are deliberately bounded. */
export function codexDesktopStartupImports(source:string):string[]{
  const program=parse(source,{ecmaVersion:'latest',sourceType:'script'}) as Node
  const paths=new Set<string>()
  const add=(value:unknown)=>{
    if(typeof value!=='string'||!/^\.\/[\w.-]+\.js$/.test(value))throw new Error('unsupported desktop chunk path')
    paths.add(value)
    if(paths.size>64)throw new Error('desktop chunk count')
  }
  for(const call of nodes(program,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name==='require'&&n.arguments.length===1)){
    const path=literal(call.arguments[0])
    if(typeof path==='string'&&path.startsWith('.'))add(path)
  }
  const maps=nodes(program,n=>n.type==='AssignmentExpression'&&n.operator==='='&&member(n.left,'u')&&['ArrowFunctionExpression','FunctionExpression'].includes(n.right.type))
  if(maps.length>1)throw new Error('ambiguous desktop chunk resolver')
  for(const map of maps){
    const owner=map.left.object
    if(owner.type!=='Identifier'||map.right.params.length!==1||map.right.params[0].type!=='Identifier')throw new Error('desktop chunk resolver signature')
    const arg=map.right.params[0].name
    const loaders=nodes(program,n=>n.type==='CallExpression'&&n.callee.name==='require'&&n.arguments.length===1&&n.arguments[0].type==='BinaryExpression'&&n.arguments[0].operator==='+'&&literal(n.arguments[0].left)==='./'&&n.arguments[0].right.type==='CallExpression'&&member(n.arguments[0].right.callee,'u')&&n.arguments[0].right.callee.object.name===owner.name)
    if(loaders.length!==1)throw new Error('desktop chunk loader contract')
    const expression=map.right.body.type==='BlockStatement'?map.right.body.body.length===1&&map.right.body.body[0].type==='ReturnStatement'?map.right.body.body[0].argument:undefined:map.right.body
    if(!expression)throw new Error('desktop chunk resolver body')
    const tables=nodes(expression,n=>n.type==='MemberExpression'&&n.computed&&n.object.type==='ObjectExpression'&&n.property.name===arg)
    if(tables.length!==1||tables[0].object.properties.length>64)throw new Error('desktop chunk filename map')
    const table=new Map<string,string>()
    for(const prop of tables[0].object.properties){
      const key=prop.key?.type==='Identifier'?prop.key.name:prop.key?.value,value=prop.value?.value
      if(prop.type!=='Property'||prop.computed||prop.kind!=='init'||!/^\d+$/.test(String(key))||typeof value!=='string'||!/^[\w-]+$/.test(value)||table.has(String(key)))throw new Error('desktop chunk map entry')
      table.set(String(key),value)
    }
    const evaluate=(node:Node,id:string):string=>{
      if(node.type==='Literal'&&typeof node.value==='string')return node.value
      if(node.type==='Identifier'&&node.name===arg)return id
      if(node===tables[0])return table.get(id)!
      if(node.type==='BinaryExpression'&&node.operator==='+')return evaluate(node.left,id)+evaluate(node.right,id)
      throw new Error('dynamic desktop chunk filename')
    }
    for(const id of table.keys())add('./'+evaluate(expression,id))
  }
  return [...paths]
}
