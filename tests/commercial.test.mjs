import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { inference, stripeClient } from '../src/providers.mjs';
import { seal, unseal, verifyStripeSignature, hash } from '../src/security.mjs';
import { build } from '../scripts/build.mjs';
const DAY = 86400000;
const cfg = (extra = {}) => loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', DATA_ENCRYPTION_KEY: 'ab'.repeat(32), OPENROUTER_API_KEY: 'fake-openrouter', STRIPE_SECRET_KEY: 'sk_test_only', STRIPE_PRICE_ID: 'price_pro', STRIPE_WEBHOOK_SECRET: 'whsec_test_only', RESEND_API_KEY: '', EMAIL_FROM: '', ...extra });
function storeFor(t, extra) { let now = Date.UTC(2026,8,16); const s = new Store(cfg(extra), () => now); t.after(() => s.close()); return { s, advance: ms => now += ms, set: value => now = value }; }
const commitUsage = (s,id,key=randomUUID()) => { s.reserve(id,key,key); s.finish(id,key,{text:'segredo da conversa'}); return key; };
function stripeFixture() {
  const state = { subscriptions: [], calls: [], checkout: { id: 'cs_test_one', status: 'open', url: 'https://checkout.stripe.com/c/pay/test' }, fail: false };
  state.request = async (path, values, key, method) => {
    state.calls.push({path,values,key,method}); if (state.fail) throw new Error('upstream secret should not leak');
    if (path.startsWith('/prices/')) return {active:true,type:'recurring',recurring:{interval:'month',interval_count:1},unit_amount:2990,currency:'brl'};
    if (path === '/customers') return {id:'cus_test'};
    if (path.startsWith('/subscriptions?')) return {data:state.subscriptions,has_more:false};
    if (path === '/checkout/sessions') return state.checkout;
    if (path.startsWith('/checkout/sessions/')) return state.checkout;
    if (path === '/billing_portal/sessions') return {url:'https://billing.stripe.com/p/session/test'};
    if (method === 'DELETE' && path.startsWith('/customers/')) { state.subscriptions=[]; return {deleted:true}; }
    throw new Error(`Unexpected fake Stripe call: ${path}`);
  };
  return state;
}
function sub(status='active', until=Date.now()+30*DAY, extra={}) { return { id:'sub_test', status, created:1, items:{data:[{price:{id:'price_pro'},current_period_end:Math.floor(until/1000)}]}, ...extra }; }
async function httpFor(t, options = {}) {
  const codes = new Map(), stripe = stripeFixture(); let now = Date.UTC(2026,8,16), calls=0;
  const c = cfg(options.env); const app = createApp(c,{clock:()=>now,stripe:stripe.request,mail:async(email,code)=>codes.set(email,code),ai:async(...args)=>{calls++; return options.ai ? options.ai(...args) : {text:'resultado privado'};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();}));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,{body,token,headers={},method=body?'POST':'GET'}={})=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json(),headers:response.headers};};
  const login=async(email='user@example.test')=>{assert.equal((await request('/auth/request-code',{body:{email}})).status,202);const r=await request('/auth/verify',{body:{email,code:codes.get(email)}});assert.equal(r.status,200);return r.body;};
  const aiRequest=(token,key=randomUUID(),body={data:'UklGRg==',format:'wav'})=>request('/transcribe',{token,body,headers:{'Idempotency-Key':key}});
  return {...app,c,codes,stripe,base,request,login,aiRequest,advance:ms=>now+=ms,calls:()=>calls,now:()=>now};
}
function sign(c,event,time) { const raw=Buffer.from(JSON.stringify(event)), ts=Math.floor(time/1000);return {raw,signature:`t=${ts},v1=${createHmac('sha256',c.webhookSecret).update(`${ts}.`).update(raw).digest('hex')}`}; }

test('configuration rejects unsafe production and invalid trial lengths',()=>{
  assert.throws(()=>cfg({TRIAL_DAYS:'10'}),/7 ou 14/);
  assert.throws(()=>cfg({DATA_ENCRYPTION_KEY:'short'}),/64/);
  assert.throws(()=>cfg({PUBLIC_BASE_URL:'https://service.test/path'}),/origem/);
  assert.throws(()=>cfg({EXTENSION_ORIGINS:'chrome-extension://*'}),/exatos/);
  assert.throws(()=>cfg({NODE_ENV:'production'}));
});
test('AES-GCM rejects tampering and cross-account context',()=>{
  const key='ab'.repeat(32), sealed=seal(key,{email:'private@test.example'},'a');
  assert.deepEqual(unseal(key,sealed,'a'),{email:'private@test.example'});
  assert.throws(()=>unseal(key,sealed,'b'));
  assert.throws(()=>unseal('cd'.repeat(32),sealed,'a'));
});
test('30 actions allowed, 31st blocked atomically; next UTC month resets',t=>{
  const {s,set}=storeFor(t),a=s.create('u@test.example');for(let i=0;i<30;i++)commitUsage(s,a.id);
  assert.equal(s.used(a.id),30);assert.throws(()=>s.reserve(a.id,'next','next'),e=>e.status===402);
  set(Date.UTC(2026,9,1));assert.equal(s.used(a.id),0);commitUsage(s,a.id);
});
for(const days of [7,14])test(`trial lasts exactly ${days} days and cannot restart`,t=>{
  const {s,advance}=storeFor(t,{TRIAL_DAYS:String(days),FREE_MONTHLY_ACTIONS:'1'}),a=s.create('trial@test.example');
  const trial=s.startTrial(a.id);assert.equal(s.entitlement(trial).plan,'trial');commitUsage(s,a.id);commitUsage(s,a.id);
  advance(days*DAY-1);assert.equal(s.entitlement(s.account(a.id)).unlimited,true);
  advance(1);assert.equal(s.entitlement(s.account(a.id)).plan,'free');assert.throws(()=>s.startTrial(a.id),e=>e.status===409);
  s.db.prepare('DELETE FROM accounts WHERE id=?').run(a.id);assert.equal(s.create(a.email).trialUsed,true);
});
test('paid access has no monthly quota, expires and does not trust canceled state',t=>{
  const {s,advance}=storeFor(t,{FREE_MONTHLY_ACTIONS:'1'}),a=s.create('paid@test.example');
  s.save({...a,billingStatus:'active',paidUntil:s.clock()+DAY});for(let i=0;i<40;i++)commitUsage(s,a.id);
  advance(DAY);assert.throws(()=>s.reserve(a.id,'expired','expired'),e=>e.status===402);
  assert.equal(s.entitlement({...a,billingStatus:'canceled',paidUntil:s.clock()+DAY}).unlimited,false);
});
test('reservations cap concurrency and refund failed actions',t=>{
  const {s}=storeFor(t),a=s.create('concurrent@test.example');s.reserve(a.id,'one','one');s.reserve(a.id,'two','two');
  assert.throws(()=>s.reserve(a.id,'three','three'),e=>e.code==='BUSY');assert.equal(s.used(a.id),2);
  s.release(a.id,'one');assert.equal(s.used(a.id),1);s.reserve(a.id,'three','three');
});
test('idempotency returns cached encrypted result and rejects changed payload',t=>{
  const {s,advance}=storeFor(t),a=s.create('idem@test.example'),key=commitUsage(s,a.id);
  assert.deepEqual(s.reserve(a.id,key,key),{text:'segredo da conversa'});assert.equal(s.used(a.id),1);
  assert.throws(()=>s.reserve(a.id,key,'altered'),e=>e.status===409);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM usage').all()).includes('segredo'));
  advance(601000);s.cleanup();assert.throws(()=>s.reserve(a.id,key,key),e=>e.code==='RESULT_EXPIRED');
});
test('usage, trial and encrypted identity survive process restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'dia-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const c=cfg({DATABASE_PATH:join(dir,'db.sqlite')});
  let s=new Store(c),a=s.create('private@example.test');s.startTrial(a.id);commitUsage(s,a.id);s.close();
  assert.ok(!readFileSync(c.database).includes(Buffer.from(a.email)));assert.ok(!readFileSync(c.database).includes(Buffer.from('segredo da conversa')));
  s=new Store(c);assert.equal(s.account(a.id).trialUsed,true);assert.equal(s.used(a.id),1);s.close();
});
test('abandoned reservation leases expire after two minutes',t=>{
  const {s,advance}=storeFor(t),a=s.create('lease@test.example');s.reserve(a.id,'lease','lease');advance(120001);s.cleanup();assert.equal(s.used(a.id),0);s.reserve(a.id,'lease','lease');
});
test('retention removes expired sessions/codes, 90-day metadata, 180-day tombstones',t=>{
  const {s,advance}=storeFor(t),a=s.create('retention@test.example');s.startTrial(a.id);commitUsage(s,a.id);
  s.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash('tok'),a.id,s.clock()+1);s.db.prepare('INSERT INTO events VALUES(?,?)').run('evt_1',s.clock());
  advance(181*DAY);s.cleanup();for(const table of ['usage','sessions','events','trial_claims'])assert.equal(s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('Stripe webhook signatures require exact raw bytes and recent timestamp',()=>{
  const c=cfg(),e={id:'evt_1',type:'test',livemode:false},now=Date.now(),signed=sign(c,e,now);
  verifyStripeSignature(signed.raw,signed.signature,c.webhookSecret,now);
  assert.throws(()=>verifyStripeSignature(Buffer.from('{}'),signed.signature,c.webhookSecret,now));
  assert.throws(()=>verifyStripeSignature(signed.raw,signed.signature,c.webhookSecret,now+301000));
  assert.throws(()=>verifyStripeSignature(signed.raw,`${signed.signature},t=1`,c.webhookSecret,now));
  verifyStripeSignature(signed.raw,`${signed.signature},v1=${'0'.repeat(64)}`,c.webhookSecret,now);
});
test('protected endpoints reject anonymous and foreign web origins',async t=>{
  const h=await httpFor(t);assert.equal((await h.request('/me')).status,401);
  assert.equal((await h.request('/health',{headers:{Origin:'https://attacker.test'}})).status,403);
  const r=await h.request('/health',{headers:{Origin:`chrome-extension://${'a'.repeat(32)}`}});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),`chrome-extension://${'a'.repeat(32)}`);
});
test('email codes are single-use, session is hashed and logout revokes it',async t=>{
  const h=await httpFor(t),u=await h.login();assert.equal(u.token.length,43);
  assert.equal((await h.request('/auth/verify',{body:{email:u.account.email,code:h.codes.get(u.account.email)}})).status,400);
  assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM sessions').all()).includes(u.token));
  assert.equal((await h.request('/auth/logout',{token:u.token,body:{}})).status,200);assert.equal((await h.request('/me',{token:u.token})).status,401);
});
test('email code brute force is locked after five incorrect attempts',async t=>{
  const h=await httpFor(t),email='locked@test.example';await h.request('/auth/request-code',{body:{email}});
  for(let i=0;i<5;i++)assert.equal((await h.request('/auth/verify',{body:{email,code:'bad'}})).status,400);
  assert.equal((await h.request('/auth/verify',{body:{email,code:h.codes.get(email)}})).status,400);
});
test('expired session and expired code cannot authenticate',async t=>{
  const h=await httpFor(t),u=await h.login();h.advance(31*DAY);assert.equal((await h.request('/me',{token:u.token})).status,401);
  await h.request('/auth/request-code',{body:{email:u.account.email}});h.advance(600001);assert.equal((await h.request('/auth/verify',{body:{email:u.account.email,code:h.codes.get(u.account.email)}})).status,400);
});
test('HTTP model selection is server-owned and replay does not consume quota twice',async t=>{
  let input;const h=await httpFor(t,{ai:async(_kind,value)=>{input=value;return {text:'ok'};}}),u=await h.login(),key=randomUUID();
  assert.equal((await h.aiRequest(u.token,key,{data:'UklGRg==',format:'wav',model:'expensive/attacker'})).status,200);assert.equal(input.model,h.c.model);
  assert.equal((await h.aiRequest(u.token,key,{data:'UklGRg==',format:'wav',model:'other/model'})).status,200);assert.equal(h.calls(),1);
  assert.equal((await h.aiRequest(u.token,key,{data:'YQ==',format:'wav'})).status,409);
});
test('input validation rejects malformed base64, unknown format, missing text and no idempotency key',async t=>{
  const h=await httpFor(t),u=await h.login();
  for(const body of [{data:'%%%=',format:'wav'},{data:'a===',format:'wav'},{data:'UklGRg==',format:'exe'},{data:'',format:'wav'}])assert.equal((await h.aiRequest(u.token,randomUUID(),body)).status,400);
  assert.equal((await h.request('/summarize',{token:u.token,body:{text:''},headers:{'Idempotency-Key':randomUUID()}})).status,400);
  assert.equal((await h.request('/transcribe',{token:u.token,body:{data:'YQ==',format:'wav'}})).status,400);assert.equal(h.calls(),0);
});
test('provider failures refund quota and never leak upstream details',async t=>{
  const h=await httpFor(t,{ai:async()=>{throw new Error('sk_live_very_secret');}}),u=await h.login();const r=await h.aiRequest(u.token);
  assert.equal(r.status,500);assert.ok(!JSON.stringify(r.body).includes('secret'));assert.equal(h.store.used(u.account.id),0);
});
test('free quota enforced by HTTP, not local browser storage; trial unblocks',async t=>{
  const h=await httpFor(t,{env:{FREE_MONTHLY_ACTIONS:'1'}}),u=await h.login();assert.equal((await h.aiRequest(u.token)).status,200);assert.equal((await h.aiRequest(u.token)).status,402);
  assert.equal((await h.request('/trial',{token:u.token,body:{}})).status,200);assert.equal((await h.aiRequest(u.token)).status,200);assert.equal((await h.request('/trial',{token:u.token,body:{}})).status,409);
});
test('different accounts cannot read each other or share cached AI results',async t=>{
  const h=await httpFor(t),a=await h.login('a@test.example'),b=await h.login('b@test.example'),key=randomUUID();
  await h.aiRequest(a.token,key);await h.aiRequest(b.token,key);assert.equal(h.calls(),2);
  const r=await h.request('/account/export',{token:b.token});assert.equal(r.body.account.email,b.account.email);assert.ok(!JSON.stringify(r.body).includes(a.account.email));
});
test('parallel checkout requests reuse one customer and open Checkout Session',async t=>{
  const h=await httpFor(t),u=await h.login();const rs=await Promise.all([1,2,3].map(()=>h.request('/billing/checkout',{token:u.token,body:{price:'attacker',customer:'cus_other'}})));
  assert.ok(rs.every(r=>r.status===200));assert.equal(new Set(rs.map(r=>r.body.url)).size,1);
  assert.equal(h.stripe.calls.filter(c=>c.path==='/customers').length,1);assert.equal(h.stripe.calls.filter(c=>c.path==='/checkout/sessions').length,1);
  const checkout=h.stripe.calls.find(c=>c.path==='/checkout/sessions');assert.equal(checkout.values['line_items[0][price]'],'price_pro');assert.equal(checkout.values.customer,'cus_test');assert.ok(checkout.key.startsWith('dia-checkout-'));
});
test('existing active or past_due subscription blocks duplicate sale and uses own portal',async t=>{
  const h=await httpFor(t),u=await h.login();await h.request('/billing/checkout',{token:u.token,body:{}});
  for(const status of ['active','past_due','incomplete','unpaid']){h.stripe.subscriptions=[sub(status,h.now()+DAY)];assert.equal((await h.request('/billing/checkout',{token:u.token,body:{}})).status,409);}
  assert.equal((await h.request('/billing/portal',{token:u.token,body:{customer:'cus_wrong'}})).status,200);assert.equal(h.stripe.calls.at(-1).values.customer,'cus_test');
});
test('canceled subscriber may purchase again, completed unconfirmed payment may not',async t=>{
  const h=await httpFor(t),u=await h.login();await h.request('/billing/checkout',{token:u.token,body:{}});h.stripe.checkout={...h.stripe.checkout,status:'complete',subscription:'sub_test'};
  assert.equal((await h.request('/billing/checkout',{token:u.token,body:{}})).status,409);
  h.stripe.subscriptions=[sub('canceled',h.now()-DAY)];assert.equal((await h.request('/billing/checkout',{token:u.token,body:{}})).status,200);
});
test('webhooks reconcile fresh Stripe state; old and duplicate events cannot restore canceled Pro',async t=>{
  const h=await httpFor(t),u=await h.login();await h.request('/billing/checkout',{token:u.token,body:{}});
  const hook=async(id,status)=>{const e={id,type:'customer.subscription.updated',livemode:false,data:{object:{customer:'cus_test',status}}},s=sign(h.c,e,h.now());const r=await fetch(h.base+'/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':s.signature},body:s.raw});return r.status;};
  h.stripe.subscriptions=[sub('active',h.now()+DAY)];assert.equal(await hook('evt_active','active'),200);assert.equal(h.store.entitlement(h.store.account(u.account.id)).plan,'pro');
  h.stripe.subscriptions=[sub('canceled',h.now()+DAY)];assert.equal(await hook('evt_canceled','canceled'),200);assert.equal(await hook('evt_old','active'),200);assert.equal(h.store.entitlement(h.store.account(u.account.id)).plan,'free');
  const before=h.stripe.calls.length;assert.equal(await hook('evt_old','active'),200);assert.equal(h.stripe.calls.length,before);
});
test('invalid signature and test/live mismatch cannot change entitlements',async t=>{
  const h=await httpFor(t),e={id:'evt_wrong',type:'test',livemode:true};const s=sign(h.c,e,h.now());
  for(const signature of [s.signature,'t=1,v1=bad']){const r=await fetch(h.base+'/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':signature},body:s.raw});assert.equal(r.status,400);}
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM events').get().n,0);
});
test('deletion cancels Stripe customer, cascades data, invalidates session and limits trial reset',async t=>{
  const h=await httpFor(t),u=await h.login();await h.request('/billing/checkout',{token:u.token,body:{}});await h.aiRequest(u.token);
  assert.equal((await h.request('/account',{token:u.token,method:'DELETE',body:{confirm:'no'}})).status,400);
  assert.equal((await h.request('/account',{token:u.token,method:'DELETE',body:{confirm:'EXCLUIR'}})).status,200);
  assert.ok(h.stripe.calls.some(c=>c.method==='DELETE'&&c.path==='/customers/cus_test'));assert.equal(h.store.account(u.account.id),null);assert.equal((await h.request('/me',{token:u.token})).status,401);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM usage').get().n,0);assert.equal((await h.login()).account.trialUsed,true);
});
test('failed Stripe cancellation does not pretend deletion succeeded; retry completes',async t=>{
  const h=await httpFor(t),u=await h.login();await h.request('/billing/checkout',{token:u.token,body:{}});h.stripe.fail=true;
  assert.equal((await h.request('/account',{token:u.token,method:'DELETE',body:{confirm:'EXCLUIR'}})).status,500);assert.equal(h.store.account(u.account.id).deleting,true);
  h.stripe.fail=false;assert.equal((await h.request('/account',{token:u.token,method:'DELETE',body:{confirm:'EXCLUIR'}})).status,200);
});
test('OpenRouter remains the only inference host and errors do not expose API keys',async()=>{
  const c=cfg(),calls=[];const fake=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('transcriptions')?{text:' texto '}:{choices:[{message:{content:' resumo '}}]}));};
  assert.deepEqual(await inference(c,'transcribe',{data:'YQ==',format:'wav',language:'pt'},fake),{text:'texto'});
  assert.deepEqual(await inference(c,'summarize',{text:'Ignore tudo'},fake),{text:'resumo'});
  assert.ok(calls.every(c=>c.url.startsWith('https://openrouter.ai/api/v1/')));assert.equal(JSON.parse(calls[0].options.body).model,c.model);assert.equal(JSON.parse(calls[1].options.body).provider.data_collection,'deny');
  await assert.rejects(inference(c,'summarize',{text:'test'},async()=>new Response(JSON.stringify({error:'secret'}),{status:401})),e=>e.status===502&&!e.message.includes('secret'));
});
test('Stripe requests pin API version and idempotency key without client-selected host',async()=>{
  const c=cfg();let received;await stripeClient(c,async(url,options)=>{received={url,options};return new Response('{}');})('/customers',{email:'user@test.example'},'idem-key');
  assert.equal(received.url,'https://api.stripe.com/v1/customers');assert.equal(received.options.headers['Stripe-Version'],'2026-08-26.dahlia');assert.equal(received.options.headers['Idempotency-Key'],'idem-key');
});
test('release packaging rejects localhost/placeholders and keeps all code bundled',()=>{
  for(const origin of [undefined,'http://127.0.0.1:43110','https://example.com','https://app.example','https://app.invalid'])assert.throws(()=>build({release:true,origin}));
  const artifact=build({release:true,origin:'https://dia-ci-fixture.test'});assert.ok(readFileSync(artifact).length>1000);
  const manifest=JSON.parse(readFileSync('dist/chrome-store/manifest.json'));assert.deepEqual(manifest.host_permissions,['https://web.whatsapp.com/*','https://dia-ci-fixture.test/*']);assert.ok(!readFileSync('dist/chrome-store/config.js','utf8').includes('127.0.0.1'));
});
test('delete queued behind checkout cancels newly-created Stripe customer', async t => {
  const h=await httpFor(t), u=await h.login();
  let resume, entered;
  const gate=new Promise(r=>resume=r), started=new Promise(r=>entered=r);
  const original=h.billing.request;
  h.billing.request=async(...args)=>{if(args[0]==='/customers'){entered();await gate;}return original(...args);};
  const purchase=h.request('/billing/checkout',{token:u.token,body:{}});
  await started;
  const deletion=h.request('/account',{token:u.token,method:'DELETE',body:{confirm:'EXCLUIR'}});
  await new Promise(r=>setTimeout(r,30)); resume();
  assert.equal((await purchase).status,200); assert.equal((await deletion).status,200);
  assert.ok(h.stripe.calls.some(c=>c.path==='/customers/cus_test' && c.method==='DELETE'));
  assert.equal(h.store.account(u.account.id),null);
});
