import test from 'node:test'
import assert from 'node:assert/strict'
import {parseProxyNode,proxyNodeName} from '../src/main/proxyNode'
import {normalizeProxy,proxyAddressView} from '../src/main/proxyPolicy'
import {proxyImportFingerprint,prepareProxyImport} from '../src/main/proxyImport'

const id='11111111-2222-3333-4444-555555555555',b64=(v:string)=>Buffer.from(v).toString('base64')
test('share links preserve six protocols, secrets, Unicode, IPv6 and TLS/transport options',()=>{
  const ss=parseProxyNode(`ss://${b64('aes-256-gcm:p+a:ss🔑')}@[::1]:1234#测试`)
  assert.deepEqual(ss,{name:'account-node',type:'ss',server:'::1',port:1234,cipher:'aes-256-gcm',password:'p+a:ss🔑'})
  const vmess=`vmess://${b64(JSON.stringify({v:'2',ps:'东京',add:'localhost',port:2345,id,tls:'tls',net:'ws',path:'/chat',host:'cdn.invalid',sni:'node.invalid'},null,2))}`
  assert.equal(proxyNodeName(vmess),'东京');assert.equal(parseProxyNode(vmess).servername,'node.invalid')
  assert.deepEqual(parseProxyNode(vmess)['ws-opts'],{path:'/chat',headers:{Host:'cdn.invalid'}})
  const reality=parseProxyNode(`vless://${id}@localhost:443?security=reality&pbk=${Buffer.alloc(32,1).toString('base64url')}&sid=abcd&flow=xtls-rprx-vision`)
  assert.equal(reality['client-fingerprint'],'chrome');assert.equal(reality.flow,'xtls-rprx-vision')
  const trojan=parseProxyNode('trojan://p%3A%2B%40@localhost?type=httpupgrade&path=%2Fws&host=cdn.invalid&sni=node.invalid')
  assert.equal(trojan.password,'p:+@');assert.equal(trojan.port,443);assert.deepEqual(trojan['ws-opts'],{path:'/ws',headers:{Host:'cdn.invalid'},'v2ray-http-upgrade':true})
  const hy=parseProxyNode('hy2://user:p+a@localhost?obfs=salamander&obfs-password=secret+obfs&alpn=h3')
  assert.equal(hy.password,'user:p+a');assert.equal(hy['obfs-password'],'secret+obfs');assert.deepEqual(hy.alpn,['h3'])
  const tuic=parseProxyNode(`tuic://${id}:p%40ss@localhost?congestion_control=bbr&udp_relay_mode=quic&insecure=0`)
  assert.equal(tuic.password,'p@ss');assert.equal(tuic['congestion-controller'],'bbr');assert.equal(tuic['udp-relay-mode'],'quic')
  const grpc=parseProxyNode(`vless://${id}@localhost:443?type=grpc&serviceName=a+b`)
  assert.deepEqual(grpc['grpc-opts'],{'grpc-service-name':'a+b'})
})
test('unsupported, ambiguous, path and certificate bypass options fail with fixed credential-free errors',()=>{
  const cases=[`vless://${id}@localhost:443?type=tcp&path=/ignored`,`vless://${id}@localhost:443?security=tls&security=none`,
    `vless://${id}@localhost:443?dialer-proxy=secret`,`vless://${id}@localhost:443?security=tls&allowInsecure=1`,
    'trojan://secret@localhost?insecure=true','trojan://secret@localhost?type=ws&serviceName=ignored',
    `vless://${id}:@localhost:443`,`vless://${id}@localhost:0`,`vless://${id}@localhost:443/path`,
    'hy2://secret@localhost?obfs-password=orphan',`tuic://${id}@localhost`,
    `ss://${b64('2022-blake3-aes-256-gcm:bad-key')}@localhost:443`,
    `ss://${b64('aes-256-gcm:secret\n')}@localhost:443`,
    `vmess://${b64(JSON.stringify({add:'localhost\n',port:443,id}))}`,
    `vmess://${Buffer.from([0xff]).toString('base64')}`,`vless://${id}@${'x'.repeat(254)}:443`,
    `vless://${id}@localhost:443?serviceName=%00`, 'trojan://secret@localhost#%ff',
    `vless://${id}@localhost:443?security=tls&sni=${'a'.repeat(8192)}`]
  for(const raw of cases)assert.throws(()=>parseProxyNode(raw),error=>error instanceof Error&&/节点/.test(error.message)&&!error.message.includes('secret'))
})
test('node previews and semantic deduplication preserve options without exposing credentials',()=>{
  const first=`trojan://very-secret@localhost?type=ws&path=%2Fchat&sni=node.invalid#A`
  const reordered='trojan://very-secret@localhost?sni=node.invalid&path=/chat&type=ws#B'
  assert.equal(proxyImportFingerprint(first),proxyImportFingerprint(reordered))
  for(const changed of [first.replace('very-secret','other-secret'),first.replace('node.invalid','other.invalid'),first.replace('%2Fchat','%2Fother')])assert.notEqual(proxyImportFingerprint(first),proxyImportFingerprint(changed))
  const vmess=`vmess://${b64(JSON.stringify({ps:'东京',add:'localhost',port:443,id}))}`
  const imported=prepareProxyImport([first,reordered,vmess].join('\n'),{format:'auto',protocol:'http',skipDuplicates:true,skipInvalid:false},[])
  assert.equal(imported.resources.length,2);assert.equal(imported.preview.rows[2].name,'东京')
  assert.equal(JSON.stringify(imported.preview).includes('very-secret'),false)
  assert.equal(normalizeProxy(first),first);assert.deepEqual(proxyAddressView(first),{mode:'custom',protocol:'TROJAN',server:'localhost',port:443,authenticated:true})
  assert.equal(proxyNodeName('trojan://secret@localhost#password=secret'),undefined)
})
