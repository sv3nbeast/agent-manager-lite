import test from 'node:test'
import assert from 'node:assert/strict'
import {parseProxyCatalog,catalogId} from '../src/main/proxyCatalogParser'
import {parseCatalogDocument} from '../src/main/proxyCatalogYaml'
import {CatalogError,normalizeNativeProxy,type CatalogErrorCode} from '../src/main/proxyNative'
import {catalogGroupNodeIds,freezeProxyCatalog,setCatalogTLSApproval,validateProxyGraph} from '../src/main/proxyCatalogGraph'

const uuid='11111111-2222-3333-4444-555555555555',key=Buffer.alloc(32,1).toString('base64')
const node=(name='Alpha',extra:Record<string,unknown>={})=>({name,type:'http',server:'node.invalid',port:8080,username:'fixture',password:'synthetic-secret',...extra})
const group=(name:string,type:string,proxies:string[],extra:Record<string,unknown>={})=>({name,type,proxies,...extra})
const catalog=(proxies:unknown[]=[node()],groups:unknown[]=[],extra:Record<string,unknown>={})=>parseProxyCatalog(JSON.stringify({proxies,'proxy-groups':groups,...extra}))
const failure=(fn:()=>unknown,code?:CatalogErrorCode)=>assert.throws(fn,(error:unknown)=>error instanceof CatalogError&&(!code||error.code===code)&&!error.message.includes('synthetic-secret'))

test('all fifteen native protocols retain supported fields and credentials without flattening',()=>{
  const fields:Record<string,Record<string,unknown>>={
    ss:{cipher:'aes-256-gcm',password:'synthetic-secret','plugin':'v2ray-plugin','plugin-opts':{mode:'websocket',tls:true}},
    ssr:{cipher:'aes-256-cfb',password:'synthetic-secret',protocol:'auth_sha1_v4',obfs:'tls1.2_ticket_auth'},
    socks5:{username:'fixture',password:'synthetic-secret',tls:true,udp:true},
    http:{username:'fixture',password:'synthetic-secret',tls:true,headers:{'X-Token':'synthetic-secret'}},
    vmess:{uuid,alterId:0,cipher:'auto',tls:true,network:'ws','ws-opts':{path:'/中文',headers:{Host:'node.invalid'}}},
    vless:{uuid,tls:true,network:'xhttp','xhttp-opts':{path:'/query'},'reality-opts':{'public-key':key,'short-id':'abcd'}},
    trojan:{password:'synthetic-secret',sni:'node.invalid',network:'grpc','grpc-opts':{'grpc-service-name':'chat'}},
    hysteria:{'auth-str':'synthetic-secret',up:'100 Mbps',down:'500 Mbps',ports:'1000-1005,2000'},
    hysteria2:{password:'synthetic-secret',udp:true,obfs:'salamander','obfs-password':'fixture','realm-opts':{enabled:false}},
    tuic:{uuid,password:'synthetic-secret','congestion-controller':'bbr','udp-relay-mode':'native'},
    wireguard:{ip:'10.0.0.1','private-key':key,'public-key':key,'reserved':[1,2,3]},
    ssh:{username:'fixture','private-key':'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----','host-key':['ssh-ed25519 fixture']},
    snell:{psk:'synthetic-secret',version:4,'obfs-opts':{mode:'http',host:'node.invalid'}},
    anytls:{password:'synthetic-secret','idle-session-timeout':30,alpn:['h2']},
    mieru:{username:'fixture',password:'synthetic-secret','port-range':'8080-8090',transport:'TCP',multiplexing:'MULTIPLEXING_LOW'}
  }
  const proxies=Object.entries(fields).map(([type,params])=>({name:type,type,server:'node.invalid',port:443,...params})),result=catalog(proxies)
  assert.equal(result.nodes.length,15)
  for(let i=0;i<proxies.length;i++){assert.equal(result.nodes[i].error,undefined);assert.deepEqual(result.nodes[i].native,proxies[i])}
  const frozen=freezeProxyCatalog(result,result.nodes.find(n=>n.name==='ssh')!.id)
  assert.equal(frozen.proxies[0]['private-key'],fields.ssh['private-key'])
  assert.equal(frozen.proxies[0].name,'account-node')
})

test('aliases normalize only when compatible, insecure definitions remain visible and unusable',()=>{
  const result=catalog([
    node('Alias',{type:'vless',username:undefined,password:undefined,uuid,sni:'node.invalid',servername:'node.invalid'}),
    node('Conflict',{type:'trojan',username:undefined,sni:'one.invalid',servername:'two.invalid'}),
    node('Ports',{type:'hysteria2',username:undefined,mport:'1000-2000,3000',ports:'1000-2000,3000'}),
    node('Insecure',{tls:true,'skip-cert-verify':true}),
    node('Nested',{type:'vless',username:undefined,password:undefined,uuid,'ws-opts':{insecure:true}})
  ])
  assert.equal(result.nodes[0].native!.servername,'node.invalid');assert.equal('sni' in result.nodes[0].native!,false)
  assert.equal(result.nodes[1].error,'SUBSCRIPTION_INVALID')
  assert.equal(result.nodes[2].native!.ports,'1000-2000,3000');assert.equal('mport' in result.nodes[2].native!,false)
  for(const item of result.nodes.slice(3)){assert.equal(item.error,'PROXY_TLS_INSECURE');assert.ok(item.native);failure(()=>freezeProxyCatalog(result,item.id),'PROXY_TLS_INSECURE')}
  failure(()=>normalizeNativeProxy({name:'Conflict',type:'hysteria2',server:'node.invalid',port:443,mport:'1',ports:'2'}),'PROXY_UNSUPPORTED_OPTION')
})

test('native boundary refuses local files, outbound detours, missing SSH identity and ignored flags',()=>{
  const disallowed=[
    node('File',{certificate:'/Users/example/private.pem'}),node('Key',{'private-key':'/tmp/key'}),
    node('Nested',{headers:{nested:{client_key:'/tmp/key'}}}),node('Detour',{'dialer-proxy':'DIRECT'}),
    node('Plugin',{type:'ss',username:undefined,cipher:'aes-256-gcm',plugin:'exec', 'plugin-opts':{command:'/tmp/exec'}}),
    node('SSH',{type:'ssh'}),node('HY2',{type:'hysteria2',username:undefined,udp:false}),
    node('StringBool',{'skip-cert-verify':'false'}),node('Ports',{type:'hysteria',username:undefined,password:undefined,ports:'3000-2000'}),
    node('ECH',{type:'trojan',username:undefined,'ech-opts':{'query-server-name':'name/with/path'}})
  ]
  for(const item of catalog(disallowed).nodes){assert.ok(item.error);assert.equal(item.native,undefined)}
  const wg=normalizeNativeProxy({name:'WG',type:'wireguard','private-key':key,peers:[{server:'peer.invalid',port:1234,'public-key':key}]})
  assert.equal(wg.server,undefined)
  assert.equal(normalizeNativeProxy({name:'Mieru',type:'mieru',server:'node.invalid','port-range':'1000-2000'}).port,undefined)
  failure(()=>normalizeNativeProxy({name:'Mieru',type:'mieru',server:'node.invalid','port-range':'invalid'}))
})

test('bounded YAML/JSON accepts quoted punctuation, multiline PEM and ordinary aliases',()=>{
  const parsed=parseProxyCatalog(`defaults: &shared [h2, http/1.1]
proxies:
  - name: '节点 ! 东京'
    type: trojan
    server: node.invalid
    port: 443
    password: '!token: #synthetic-secret'
    alpn: *shared
  - name: SSH
    type: ssh
    server: node.invalid
    port: 22
    username: fixture
    host-key: ['ssh-ed25519 fixture']
    private-key: |
      -----BEGIN OPENSSH PRIVATE KEY-----
      fixture
      -----END OPENSSH PRIVATE KEY-----
proxy-groups:
  - name: 选择
    type: select
    proxies: ['节点 ! 东京', SSH]
`)
  assert.deepEqual(parsed.nodes[0].native!.alpn,['h2','http/1.1'])
  assert.equal(parsed.nodes[0].native!.password,'!token: #synthetic-secret')
  assert.ok(parsed.nodes[1].native!['private-key'])
  assert.equal(parsed.groups[0].error,undefined)
  const many=parseCatalogDocument(`anchor: &entry [one, two]\nrefs: [${Array(200).fill('*entry').join(',')}]`) as {refs:unknown[]}
  assert.equal(many.refs.length,200);assert.notEqual(many.refs[0],many.refs[1])
  assert.deepEqual(parseCatalogDocument('a: &x one\nb: *x\nc: &x two\nd: *x'),{a:'one',b:'one',c:'two',d:'two'})
})

test('YAML rejects duplicate keys, non-string keys, explicit tags, cycles and amplified inputs',()=>{
  const invalid=[
    '{"proxies": [], "proxies": []}', 'a: one\na: two', '1: value', '? [one, two]\n: value',
    'a: !!str value','a: ! value','a: !custom value','a: &x [*x]','a: *missing',
    'a: .inf','a: .nan','a: 9007199254740993','a: !!binary c2VjcmV0',
    'a: one\n---\nb: two',`a: ${'['.repeat(40)}0${']'.repeat(40)}`,`a: "${'x'.repeat(16385)}"`
  ]
  for(const input of invalid)failure(()=>parseCatalogDocument(input))
  let bomb='a: &a [x,x,x,x,x,x,x,x,x,x]\n'
  for(let i=0;i<7;i++)bomb+=`layer${i}: &l${i} [${Array(10).fill(i?`*l${i-1}`:'*a').join(',')}]\n`
  failure(()=>parseCatalogDocument(bomb))
  const value=parseCatalogDocument('{"__proto__":{"polluted":true},"constructor":"literal"}') as Record<string,unknown>
  assert.equal(Object.getPrototypeOf(value),Object.prototype);assert.equal(({} as Record<string,unknown>).polluted,undefined)
  assert.ok(Object.hasOwn(value,'__proto__'));assert.equal(value.constructor,'literal')
  failure(()=>parseProxyCatalog('{"proxies":null,"proxy-groups":[]}'))
  failure(()=>catalog([node()],[],{'proxy-groups':null}))
})

test('catalog names, source limits and unsupported entries are explicit without parser-secret leakage',()=>{
  failure(()=>catalog([node('Same'),node(' Same ')]),'SUBSCRIPTION_DUPLICATE_NAME')
  failure(()=>catalog([node('Same')],[group('Same','select',['Same'])]),'SUBSCRIPTION_DUPLICATE_NAME')
  for(const name of ['','token=synthetic-secret','http://synthetic-secret','x\u0000y','中'.repeat(86)])failure(()=>catalog([node(name)]))
  failure(()=>parseProxyCatalog(' '.repeat(2*1024*1024+1)),'SUBSCRIPTION_TOO_LARGE')
  const bulk=Array.from({length:4096},(_,i)=>node(`Node ${i}`)),parsed=catalog(bulk)
  assert.equal(parsed.nodes.length,4096)
  failure(()=>catalog([...bulk,node('Overflow')]))
  const unsupported=catalog([node('Good'),node('Bad',{type:'secret://synthetic-secret'})],[group('Visible','secret://synthetic-secret',['Good','Bad'])])
  assert.equal(unsupported.nodes[1].protocol,'unsupported');assert.equal(unsupported.nodes[1].native,undefined)
  assert.equal(unsupported.groups[0].kind,'unsupported');assert.deepEqual(unsupported.groups[0].members,['Good','Bad'])
  assert.equal(unsupported.groups[0].error,'SUBSCRIPTION_GROUP_STRATEGY')
})

test('links and Base64 lists preserve stable IDs, protocols and rejected rows',()=>{
  const links=`https://fixture:synthetic-secret@node.invalid:443#Alpha\nvless://${uuid}@node.invalid:443?security=tls#第二个\nunknown://fixture@node.invalid#Unsupported`
  const parsed=parseProxyCatalog(links),encoded=parseProxyCatalog(Buffer.from(links).toString('base64'))
  assert.deepEqual(encoded,parsed);assert.equal(parsed.nodes[0].id,catalogId('node','Alpha'))
  assert.equal(parsed.nodes[0].native!.tls,true);assert.equal(parsed.nodes[1].native!.uuid,uuid)
  assert.equal(parsed.nodes[2].error,'PROXY_UNSUPPORTED_OPTION');assert.equal(parsed.nodes.length,3)
  const unnamed='socks5://fixture:synthetic-secret@node.invalid:1080'
  assert.equal(parseProxyCatalog(unnamed).nodes[0].id,catalogId('node',unnamed))
  failure(()=>parseProxyCatalog('/w=='))
})

test('manual group retains unusable branches and automatic strategies refuse partial candidates',()=>{
  const parsed=catalog([node('Good'),node('Bad',{type:'unsupported'})],[
    group('Choose','select',['Good','Bad','Missing','DIRECT','REJECT']),
    ...['url-test','fallback','load-balance'].map(type=>group(type,type,['Good','Bad']))
  ])
  const manual=parsed.groups[0]
  assert.equal(manual.error,undefined);assert.equal(manual.members.length,5)
  assert.deepEqual(manual.issues.map(issue=>issue.name),['Bad','DIRECT','Missing'])
  failure(()=>freezeProxyCatalog(parsed,manual.id),'PROXY_RESOURCE_SELECTION_REQUIRED')
  const frozen=freezeProxyCatalog(parsed,manual.id,{[manual.id]:'Good'})
  assert.equal(frozen.proxies.length,1);assert.equal(frozen.groups[0].proxies?.toString(),'resource-1')
  assert.equal(JSON.stringify(frozen).includes('Missing'),false)
  failure(()=>freezeProxyCatalog(parsed,manual.id,{[manual.id]:'Bad'}),'PROXY_UNSUPPORTED_OPTION')
  failure(()=>freezeProxyCatalog(parsed,manual.id,{[manual.id]:'DIRECT'}),'PROXY_RESOURCE_INVALID')
  for(const automatic of parsed.groups.slice(1)){assert.equal(automatic.error,'SUBSCRIPTION_GROUP_MEMBER_UNSUPPORTED');assert.equal(automatic.members.length,2);failure(()=>freezeProxyCatalog(parsed,automatic.id))}
  assert.equal(freezeProxyCatalog(parsed,manual.id,{[manual.id]:'REJECT'}).proxies.length,0)
})

test('include-all is frozen deterministically without fetching or executing source providers/global settings',()=>{
  const parsed=catalog([node('Zulu'),node('Alpha')],[
    group('All','select',['Zulu','Zulu'],{'include-all':true}),
    group('Use','select',['Alpha'],{use:['remote']}),
    group('Provider','select',['Alpha'],{'include-all-providers':true})
  ],{rules:['MATCH,DIRECT'],dns:{enable:true},script:{code:'synthetic-secret'}})
  assert.deepEqual(parsed.groups[0].members,['Zulu','Alpha']);assert.equal(parsed.groups[0].native!['include-all'],undefined)
  for(const rejected of parsed.groups.slice(1))assert.equal(rejected.error,'SUBSCRIPTION_PROVIDER_UNSUPPORTED')
  const providers=catalog([node()],[group('All','select',[],{'include-all':true}),group('Nodes','select',[],{'include-all-proxies':true})],{'proxy-providers':{remote:{url:'https://unused.invalid/secret'}}})
  assert.equal(providers.groups[0].error,'SUBSCRIPTION_PROVIDER_UNSUPPORTED');assert.equal(providers.groups[1].error,undefined)
  assert.equal(JSON.stringify(freezeProxyCatalog(parsed,parsed.groups[0].id,{[parsed.groups[0].id]:'Alpha'})).includes('MATCH'),false)
})

test('cycles remain visible; an explicit safe selector branch works, shared descendants are not cycles',()=>{
  const parsed=catalog([node()],[group('A','select',['B','Alpha']),group('B','select',['A']),group('C','select',['C']),group('Shared','fallback',['A','B'])])
  assert.equal(parsed.groups[0].error,undefined);assert.equal(parsed.groups[1].error,undefined)
  assert.equal(parsed.groups[2].error,'SUBSCRIPTION_GROUP_CYCLE')
  assert.ok(parsed.groups[0].issues.some(issue=>issue.error==='SUBSCRIPTION_GROUP_CYCLE'))
  const choices={[parsed.groups[0].id]:'Alpha',[parsed.groups[1].id]:'A'}
  assert.equal(freezeProxyCatalog(parsed,parsed.groups[3].id,choices).proxies.length,2)
  failure(()=>freezeProxyCatalog(parsed,parsed.groups[0].id,{...choices,[parsed.groups[0].id]:'B'}),'PROXY_RESOURCE_INVALID')
  failure(()=>catalogGroupNodeIds(parsed,parsed.groups[0].id),'SUBSCRIPTION_GROUP_CYCLE')
  const shared=catalog([node()],[group('A','select',['Alpha']),group('B','select',['Alpha']),group('C','fallback',['A','B'])])
  assert.deepEqual(catalogGroupNodeIds(shared,shared.groups[2].id),[shared.nodes[0].id])
})

test('frozen native group options and declared automatic default are preserved with opaque tags',()=>{
  const parsed=catalog([node('Alpha'),node('Beta')],[group('Auto','fallback',['Alpha','Beta'],{url:'http://127.0.0.1:8123/check',interval:0,lazy:false,timeout:3000,'max-failed-times':3,'default-selected':'Beta',hidden:true,'expected-status':'200/204','disable-udp':true})])
  const frozen=freezeProxyCatalog(parsed,parsed.groups[0].id),native=frozen.groups[0]
  assert.equal(native['default-selected'],'resource-2');assert.equal(native.interval,0);assert.equal(native.lazy,false)
  assert.equal(native['empty-fallback'],'REJECT');assert.deepEqual(frozen.names,{'account-node':'Auto','resource-1':'Alpha','resource-2':'Beta'})
  assert.deepEqual(validateProxyGraph(JSON.parse(JSON.stringify(frozen))),frozen)
  const invalidOptions=[{url:'https://user:synthetic-secret@example.com/check'},{url:'https://example.com/#'},{url:'file:///tmp/check'},{interval:86401},{tolerance:65536},{lazy:'false'},{'empty-fallback':'DIRECT'},{'interrupt-exist-connections':true},{filter:'x'}]
  for(const options of invalidOptions)assert.ok(catalog([node()],[group('Bad','url-test',['Alpha'],options)]).groups[0].error)
})

test('TLS exceptions require explicit permission, exact frozen tracking and can be revoked',()=>{
  const parsed=catalog([node('Alpha',{'skip-cert-verify':true}),node('Beta')],[group('Auto','url-test',['Alpha','Beta'])])
  assert.equal(parsed.groups[0].error,'PROXY_TLS_INSECURE')
  const approved=setCatalogTLSApproval(parsed,[parsed.nodes[0].id],true),frozen=freezeProxyCatalog(approved,approved.groups[0].id)
  assert.equal(approved.groups[0].error,undefined);assert.equal(parsed.nodes[0].error,'PROXY_TLS_INSECURE')
  assert.deepEqual(frozen.insecureNames,['resource-1'])
  failure(()=>validateProxyGraph({...frozen,insecureNames:[]}),'PROXY_RESOURCE_INVALID')
  failure(()=>validateProxyGraph({...frozen,insecureNames:['resource-1','resource-2']}),'PROXY_RESOURCE_INVALID')
  const revoked=setCatalogTLSApproval(approved,[approved.nodes[0].id],false)
  failure(()=>freezeProxyCatalog(revoked,revoked.groups[0].id),'PROXY_TLS_INSECURE')
  failure(()=>setCatalogTLSApproval(parsed,['unknown'],true),'PROXY_RESOURCE_INVALID')
})

test('frozen graph rejects orphan/duplicate/missing entries, cycles, bypasses and caller-supplied extra config',()=>{
  const parsed=catalog([node()],[group('Auto','fallback',['Alpha'])]),frozen=freezeProxyCatalog(parsed,parsed.groups[0].id)
  const invalid=[
    {...frozen,proxies:[...frozen.proxies,node('resource-2')],names:{...frozen.names,'resource-2':'Orphan'}},
    {...frozen,proxies:[...frozen.proxies,...frozen.proxies]},
    {...frozen,groups:[{...frozen.groups[0],proxies:['Missing']}]},
    {...frozen,groups:[{...frozen.groups[0],proxies:['account-node']}]},
    {...frozen,groups:[{...frozen.groups[0],proxies:['DIRECT']}]},
    {...frozen,groups:[{...frozen.groups[0],'empty-fallback':'DIRECT'}]},
    {...frozen,groups:[{...frozen.groups[0],'include-all':false}]},
    {...frozen,proxies:[{...frozen.proxies[0],certificate:'/tmp/cert.pem'}]},
    {...frozen,rules:['MATCH,DIRECT']}, {...frozen,names:{...frozen.names,'resource-1':'password=synthetic-secret'}},
    {...frozen,insecureNames:['resource-1']}
  ]
  for(const graph of invalid)failure(()=>validateProxyGraph(graph))
})

test('frozen graph caps expanded selections, nesting and bytes while leaving source catalog intact',()=>{
  const nodes=Array.from({length:512},(_,i)=>node(`Node ${i}`)),parsed=catalog(nodes,[group('All','fallback',nodes.map(n=>n.name))])
  failure(()=>freezeProxyCatalog(parsed,parsed.groups[0].id),'PROXY_RESOURCE_INVALID');assert.equal(parsed.nodes.length,512)
  const groups=Array.from({length:18},(_,i)=>group(`G${i}`,'select',[i===17?'Alpha':`G${i+1}`])),nested=catalog([node()],groups)
  failure(()=>freezeProxyCatalog(nested,nested.groups[0].id,Object.fromEntries(nested.groups.map(g=>[g.id,g.members[0]]))),'PROXY_RESOURCE_INVALID')
  const large=catalog(Array.from({length:40},(_,i)=>node(`N${i}`,{password:'x'.repeat(15000)})),[group('All','fallback',Array.from({length:40},(_,i)=>`N${i}`))])
  failure(()=>freezeProxyCatalog(large,large.groups[0].id),'PROXY_RESOURCE_INVALID')
})
