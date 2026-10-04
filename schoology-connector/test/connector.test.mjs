import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Auth, Store, hash, random, validRedirect } from '../src/auth.mjs';
import { Schoology, authorization } from '../src/schoology.mjs';
import { createConnector } from '../src/server.mjs';

const password='a-long-test-only-connector-password';
const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
function fixture() {
  const store=new Store(':memory:');
  const auth=new Auth({origin:'https://connector.example',password,store});
  const client=auth.register({redirect_uris:[redirect],token_endpoint_auth_method:'none'});
  const verifier=random();
  const params={client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:hash(verifier),code_challenge_method:'S256',resource:auth.resource,scope:'schoology:read',state:random()};
  const tx=auth.begin(params);
  return {store,auth,client,verifier,params,tx};
}
function grant(f) {
  const callback=new URL(f.auth.consent({transaction:f.tx.tx,password},f.tx.cookie,f.auth.origin));
  assert.equal(callback.searchParams.get('state'),f.params.state);
  assert.equal(callback.searchParams.get('iss'),f.auth.origin);
  return {grant_type:'authorization_code',client_id:f.client.client_id,redirect_uri:redirect,resource:f.auth.resource,code:callback.searchParams.get('code'),code_verifier:f.verifier};
}

test('redirect allowlist excludes lookalike hosts, query strings, fragments, and arbitrary paths',()=>{
  assert(validRedirect(redirect));assert(validRedirect('https://chatgpt.com/connector/oauth/abc-123'));
  for(const bad of ['https://chatgpt.com.evil.test/connector_platform_oauth_redirect','http://chatgpt.com/connector_platform_oauth_redirect',redirect+'?next=evil',redirect+'#x','https://chatgpt.com/other','https://user@chatgpt.com/connector_platform_oauth_redirect']) assert(!validRedirect(bad));
});
test('authorization requires read scope, exact resource, state and S256 PKCE',()=>{
  const f=fixture();
  for(const patch of [{scope:'schoology:write'},{resource:'https://other/mcp'},{code_challenge_method:'plain'},{state:''},{redirect_uri:'https://evil.test'}]) assert.throws(()=>f.auth.begin({...f.params,...patch}));
  f.store.close();
});
test('consent rejects wrong origin, missing cookie, and wrong password',()=>{
  const f=fixture();
  assert.throws(()=>f.auth.consent({transaction:f.tx.tx,password},f.tx.cookie,'https://evil.test'));
  assert.throws(()=>f.auth.consent({transaction:f.tx.tx,password},'',f.auth.origin));
  assert.throws(()=>f.auth.consent({transaction:f.tx.tx,password:'wrong'},f.tx.cookie,f.auth.origin));
  assert.throws(()=>f.auth.consent({transaction:f.tx.tx,password},f.tx.cookie,f.auth.origin));
  f.store.close();
});
test('codes require the bound client, redirect and verifier and are single-use',()=>{
  const f=fixture(), request=grant(f);
  for(const patch of [{code_verifier:random()},{redirect_uri:'https://chatgpt.com/connector/oauth/different'},{resource:'https://other/mcp'},{client_id:'not-client'}]) assert.throws(()=>f.auth.token({...request,...patch}));
  const tokens=f.auth.token(request);assert(f.auth.verify('Bearer '+tokens.access_token));
  assert.throws(()=>f.auth.token(request));assert(!f.auth.verify('Bearer '+random()));
  // Only hashes, never raw bearer tokens, are stored.
  assert.equal(f.store.get('access',tokens.access_token),null);
  f.store.close();
});
test('refresh rotation detects replay and revokes the entire family',()=>{
  const f=fixture(), tokens=f.auth.token(grant(f));
  const request={grant_type:'refresh_token',client_id:f.client.client_id,resource:f.auth.resource,refresh_token:tokens.refresh_token};
  const refreshed=f.auth.token(request);assert(f.auth.verify('Bearer '+refreshed.access_token));
  assert.throws(()=>f.auth.token(request));
  assert(!f.auth.verify('Bearer '+refreshed.access_token));assert(!f.auth.verify('Bearer '+tokens.access_token));
  f.store.close();
});
test('revocation invalidates access and refresh tokens',()=>{
  const f=fixture(), tokens=f.auth.token(grant(f));
  f.auth.revoke({token:tokens.access_token,client_id:f.client.client_id});
  assert(!f.auth.verify('Bearer '+tokens.access_token));
  assert.throws(()=>f.auth.token({grant_type:'refresh_token',client_id:f.client.client_id,resource:f.auth.resource,refresh_token:tokens.refresh_token}));f.store.close();
});
test('expired records and rate limits fail closed',()=>{
  const f=fixture();f.store.put('access','expired',{scope:'schoology:read'},-1);assert.equal(f.store.get('access','expired'),null);
  f.auth.rate('test',1,60);assert.throws(()=>f.auth.rate('test',1,60));f.store.close();
});

const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
test('Schoology reads paginate, exclude admins, preserve names and omit private fields',async()=>{
  const calls=[];
  const client=new Schoology({key:'test-key',secret:'test-secret',sections:['123'],fetcher:async(url,options)=>{
    calls.push({url:String(url),options});
    if(url.searchParams.has('start')) return response({enrollment:[{id:3,uid:33,name_display:'Second Student',status:1}]});
    return response({enrollment:[{id:1,uid:11,name_display:'First Student',email:'private@example.test',status:1},{id:2,admin:1,name_display:'Teacher'}],links:{next:'http://api.schoology.com/v1/sections/123/enrollments?type=member&enrollment_status=1&limit=200&start=200'}});
  }});
  const data=await client.roster('123');assert.equal(data.students.length,2);assert.equal(data.students[0].name,'First Student');
  assert(!JSON.stringify(data).includes('email'));assert.equal(calls.length,2);assert(calls.every(c=>c.options.method==='GET'));
  assert.notEqual(calls[0].options.headers.Authorization,calls[1].options.headers.Authorization);
  await assert.rejects(()=>client.roster('999'));assert.equal(calls.length,2);
});
test('Schoology refuses pagination to other hosts or resources',async()=>{
  for(const next of ['https://evil.test/leak','https://api.schoology.com/v1/sections/999/enrollments']) {
    let calls=0;const c=new Schoology({key:'k',secret:'s',sections:['123'],fetcher:async()=>{calls++;return response({enrollment:[],links:{next}});}});
    await assert.rejects(()=>c.roster('123'));assert.equal(calls,1);
  }
});
test('users/me redirect is re-signed and secret-bearing headers cannot leave Schoology',async()=>{
  const calls=[];
  const c=new Schoology({key:'k',secret:'s',sections:['123'],fetcher:async(url,options)=>{calls.push(options.headers.Authorization);return calls.length===1?new Response(null,{status:303,headers:{Location:'https://api.schoology.com/v1/users/321'}}):response({id:321,name_first:'Sample',name_last:'Teacher',email:'omit-me'});}});
  assert.equal((await c.connection()).name,'Sample Teacher');assert.notEqual(calls[0],calls[1]);
  const bad=new Schoology({key:'k',secret:'s',sections:['123'],fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://evil.test'}})});
  await assert.rejects(()=>bad.connection());
});
test('upstream errors do not echo HTML or secret values',async()=>{
  const c=new Schoology({key:'secret-key',secret:'secret-secret',sections:['123'],fetcher:async()=>new Response('private HTML secret-key',{status:403})});
  await assert.rejects(()=>c.roster('123'),e=>e.message.includes('403')&&!e.message.includes('secret-key'));
});
test('OAuth1 signature uses fixed encoded ordering and includes empty token',()=>{
  const url=new URL('https://api.schoology.com/v1/sections/123/enrollments?limit=200');
  const h=authorization(url,'test-key','test-secret','nonce',1700000000);
  assert(h.includes('oauth_token=""'));assert(h.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.equal(h,authorization(url,'test-key','test-secret','nonce',1700000000));
  assert.notEqual(h,authorization(url,'test-key','different-secret','nonce',1700000000));
});

test('HTTP OAuth, MCP initialization, roster and grade reads; write tools absent',async(t)=>{
  let schoolCalls=[];
  const api=new Schoology({key:'k',secret:'s',sections:['123'],fetcher:async(url,opt)=>{
    schoolCalls.push({url:String(url),method:opt.method});
    if(url.pathname.endsWith('/enrollments')) return response({enrollment:[{id:1,uid:2,name_display:'Test Student'}]});
    if(url.pathname.endsWith('/grades')) return response({grades:{grade:[{enrollment_id:1,assignment_id:456,grade:8,max_points:10},{enrollment_id:1,assignment_id:999,grade:4}]}});
    if(url.pathname.endsWith('/assignments')) return response({assignment:[{id:456,title:'Khan Minutes',max_points:10}]});
    return response({id:123,course_title:'Math',section_title:'806'});
  }});
  const {server,auth}=createConnector({origin:'https://connector.example',key:'k',secret:'s',sections:['123'],password,dbPath:':memory:'},{schoology:api});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(path,data,headers={})=>fetch(base+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  const metadata=await (await fetch(base+'/.well-known/oauth-protected-resource')).json();assert.equal(metadata.resource,auth.resource);
  const denied=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(denied.status,401);assert(denied.headers.get('www-authenticate').includes('resource_metadata'));
  const client=await (await post('/register',{redirect_uris:[redirect],token_endpoint_auth_method:'none'})).json();
  const verifier=random(), params={client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:hash(verifier),code_challenge_method:'S256',scope:'schoology:read',resource:auth.resource,state:random()};
  const consent=await fetch(base+'/authorize?'+new URLSearchParams(params));const html=await consent.text();const transaction=html.match(/name="transaction" value="([^"]+)"/)[1];
  assert.equal(consent.headers.get('referrer-policy'),'same-origin');
  const formTargets=consent.headers.get('content-security-policy').split(';').map(s=>s.trim()).find(s=>s.startsWith('form-action ')).split(/\s+/).slice(1);
  assert.deepEqual(formTargets,["'self'",new URL(redirect).origin]);
  const cookie=consent.headers.get('set-cookie').split(';')[0];
  for(const origin of ['null','https://evil.test','https://chatgpt.com']) {
    const blocked=await post('/authorize',{transaction,password},{Cookie:cookie,Origin:origin});
    assert.equal(blocked.status,origin==='https://chatgpt.com'?400:403);
  }
  const approved=await fetch(base+'/authorize',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:auth.origin},body:new URLSearchParams({transaction,password})});assert.equal(approved.status,303);
  assert(formTargets.includes(new URL(approved.headers.get('location')).origin));
  assert.equal(approved.headers.get('referrer-policy'),'no-referrer');
  const code=new URL(approved.headers.get('location')).searchParams.get('code');
  const tokenResponse=await post('/token',{grant_type:'authorization_code',code,code_verifier:verifier,client_id:client.client_id,redirect_uri:redirect,resource:auth.resource});
  const token=await tokenResponse.json();assert(token.access_token);
  const headers={Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream'};
  const call=async(method,params={})=>(await post('/mcp',{jsonrpc:'2.0',id:1,method,params},headers)).json();
  const init=await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.protocolVersion,'2025-06-18');
  const listing=await call('tools/list');assert.equal(listing.result.tools.length,5);assert(listing.result.tools.every(t=>t.annotations.readOnlyHint));
  const roster=await call('tools/call',{name:'get_roster',arguments:{section_id:'123'}});assert.equal(roster.result.structuredContent.students[0].name,'Test Student');
  const grades=await call('tools/call',{name:'get_assignment_grades',arguments:{section_id:'123',assignment_id:'456'}});assert.equal(grades.result.structuredContent.grades.length,1);assert.equal(grades.result.structuredContent.grades[0].grade,8);
  const restricted=await call('tools/call',{name:'get_roster',arguments:{section_id:'999'}});assert.equal(restricted.result.isError,true);
  const write=await call('tools/call',{name:'send_grades',arguments:{}});assert.equal(write.error.code,-32602);assert(schoolCalls.every(c=>c.method==='GET'));
  const injected=await call('tools/call',{name:'get_roster',arguments:{section_id:'123',url:'https://evil.test'}});assert.equal(injected.error.code,-32602);
  const blockedOrigin=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{...headers,Origin:'https://evil.test'});assert.equal(blockedOrigin.status,403);
});
