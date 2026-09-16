// Native CDP, no npm/browser automation dependencies. Synthetic WhatsApp DOM;
// actual unpacked MV3 extension and real local HTTP/auth/quota endpoints.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
const root = path.resolve(import.meta.dirname, '..'), pause = ms => new Promise(r => setTimeout(r,ms));
async function wait(fn, message, timeout=15000) { const start=Date.now(); while(Date.now()-start<timeout){try{const v=await fn();if(v)return v;}catch{}await pause(100);}throw new Error(`Timeout: ${message}`); }
const binary = process.env.CHROME_BIN || ['/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
if (!binary) throw new Error('Chromium/Chrome não encontrado. Instale Chrome para executar test:browser.');
const profile=mkdtempSync(path.join(tmpdir(),'dia-browser-'));mkdirSync('artifacts',{recursive:true});
let socket,chrome,server;let next=0;const pending=new Map(),errors=[];
const codes=new Map(),stripeCalls=[];let aiCalls=0;
const config=loadConfig({NODE_ENV:'development',DATABASE_PATH:':memory:',DATA_ENCRYPTION_KEY:'ab'.repeat(32),OPENROUTER_API_KEY:'fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_PRICE_ID:'price_pro'});
const app=createApp(config,{mail:async(e,c)=>codes.set(e,c),ai:async(kind)=>{aiCalls++;return {text:kind==='summarize'?'Resumo: confirmar o orçamento e responder até sexta-feira.':'Oi! Você consegue me enviar o orçamento até sexta-feira? Obrigado!'};},stripe:async(p,v)=>{stripeCalls.push({p,v});if(p.startsWith('/prices/'))return {active:true,type:'recurring',recurring:{interval:'month',interval_count:1},unit_amount:2990,currency:'brl'};if(p==='/customers')return {id:'cus_demo'};if(p.startsWith('/subscriptions?'))return {data:[],has_more:false};if(p==='/checkout/sessions')return {id:'cs_demo',status:'open',url:'https://checkout.stripe.com/c/pay/demo'};throw new Error('Unexpected mock Stripe endpoint');}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve:r=>{clearTimeout(timeout);resolve(r);},reject:e=>{clearTimeout(timeout);reject(e);}});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
async function tab(url) { const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);if(url)await send('Page.navigate',{url},sessionId);return {targetId,sessionId}; }
async function evaluate(t,expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},t.sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+JSON.stringify(r.exceptionDetails.exception));return r.result.value;}
async function click(t,selector){return evaluate(t,`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function value(t,selector,value){return evaluate(t,`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);}
async function screenshot(t,name,width=1280,height=800){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},t.sessionId);await pause(150);const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},t.sessionId);writeFileSync(`artifacts/${name}.png`,Buffer.from(image.data,'base64'));}
const fakeWhatsApp=`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>WhatsApp Web | Demonstração</title><style>body{margin:0;background:#efeae2;font:16px system-ui;color:#20352e}aside{position:fixed;width:250px;inset:0 auto 0 0;background:white;padding:25px}main{margin-left:310px;padding:30px}header{background:#fafafa;padding:22px;margin-bottom:24px}.message{background:white;padding:20px;border-radius:12px;max-width:600px;margin:20px 0}small{color:#526d64}button{cursor:pointer}footer{position:fixed;bottom:15px;right:25px}</style><aside><h2>Conversas</h2><p>Equipe Comercial</p><small>Dados fictícios para teste</small></aside><main id="main"><header><b title="Equipe Comercial">Equipe Comercial</b><p>Organize o que importa. Sem enviar mensagens automaticamente.</p></header><div class="message" data-id="demo-audio-1" role="row"><div data-pre-plain-text="[09:30, 16/09/2026] Ana: ">Pode enviar o orçamento até sexta-feira?</div><audio controls src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="></audio></div><div class="message" data-id="demo-text-2" role="row"><div data-pre-plain-text="[09:31, 16/09/2026] Bruno: ">Vamos revisar as condições e confirmar o prazo.</div></div></main><footer>Ambiente de demonstração. Conteúdo fictício.</footer></html>`;
try {
  server=app.server;await new Promise((r,j)=>{server.once('error',j);server.listen(43110,'127.0.0.1',r);});
  chrome=spawn(binary,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-pipe','--enable-unsafe-extension-debugging','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  chrome.stderr.on('data',()=>{});
  socket={send:data=>chrome.stdio[3].write(data+'\0'),close:()=>chrome.stdio[3].end()};
  const onMessage = event => {const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);return;}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Fetch.requestPaused'){send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(fakeWhatsApp).toString('base64')},m.sessionId).catch(e=>errors.push(e.message));}};
  let stream='';chrome.stdio[4].on('data',bytes=>{stream+=bytes.toString();let i;while((i=stream.indexOf('\0'))>=0){const message=stream.slice(0,i);stream=stream.slice(i+1);if(message)onMessage({data:message});}});
  await send('Browser.getVersion');
  const installed=await send('Extensions.loadUnpacked',{path:path.join(root,'extension')});
  const origin=`chrome-extension://${installed.id}`;
  const popup=await tab(`${origin}/popup.html`);await wait(()=>evaluate(popup,`document.querySelector('#plan-details')?.textContent.includes('29,90')`),'actual Stripe price in popup');
  assert.equal(await evaluate(popup,`document.querySelector('#automatic').checked`),false);assert.equal(await evaluate(popup,`document.querySelector('#consent').checked`),false);
  await value(popup,'#email','demo@example.test');await click(popup,'#request-form button');await wait(()=>codes.get('demo@example.test'),'verification email');await value(popup,'#code',codes.get('demo@example.test'));await click(popup,'#verify-form button');await wait(()=>evaluate(popup,`!document.querySelector('#account').hidden && document.querySelector('#identity').textContent==='demo@example.test'`),'verified login');
  const wa=await tab();await send('Fetch.enable',{patterns:[{urlPattern:'https://web.whatsapp.com/*',requestStage:'Request'}]},wa.sessionId);await send('Page.navigate',{url:'https://web.whatsapp.com/'},wa.sessionId);
  await wait(()=>evaluate(wa,`!!document.querySelector('.wpp-transcriber__button')`),'transcription controls');assert.equal(aiCalls,0);
  await click(wa,'.wpp-transcriber__button');await wait(()=>evaluate(wa,`document.querySelector('.wpp-transcriber__text')?.textContent.includes('autorize')`),'consent gate before capturing');assert.equal(aiCalls,0);
  await click(popup,'#consent');await click(popup,'#save-settings');await wait(()=>evaluate(popup,`document.querySelector('#status').textContent.includes('salvas')`),'consent saved');
  await click(wa,'.wpp-transcriber__button');await wait(()=>evaluate(wa,`document.querySelector('.wpp-transcriber__text')?.textContent.includes('orçamento até sexta')`),'transcription result');assert.equal(aiCalls,1);
  await click(wa,'.wpp-transcriber__summary');await wait(()=>evaluate(wa,`document.querySelector('.wpp-transcriber__text')?.textContent.startsWith('Resumo:')`),'summary result');assert.equal(aiCalls,2);
  await wait(()=>evaluate(popup,`chrome.storage.local.get(null).then(s=>!!s['vault:transcripts'])`),'encrypted cache persistence');
  assert.equal(await evaluate(popup,`chrome.storage.local.get(null).then(s=>JSON.stringify(s).includes('orçamento'))`),false);
  await screenshot(wa,'whatsapp-transcription');await click(popup,'#refresh');await wait(()=>evaluate(popup,`document.querySelector('#usage').textContent.includes('2 de 30')`),'server usage display');await screenshot(popup,'popup-account',420,1200);
  await send('Page.reload',{},wa.sessionId);await wait(()=>evaluate(wa,`document.querySelector('.wpp-transcriber__text')?.textContent.includes('orçamento até sexta')`),'encrypted cache restored after reload');assert.equal(aiCalls,2);
  if (existsSync(path.join(root,'extension/workspace.html'))) {
    await send('Target.activateTarget',{targetId:wa.targetId});
    const work=await tab(`${origin}/workspace.html`);
    await wait(()=>evaluate(work,`document.querySelector('#library-list')?.textContent.includes('orçamento')`),'searchable transcript library');
    await value(work,'#library-search','inexistente');await evaluate(work,`document.querySelector('#library-search').dispatchEvent(new Event('input'))`);await wait(()=>evaluate(work,`document.querySelector('#library-list').textContent.includes('Nenhum')`),'library search');
    await value(work,'#task-title','Responder orçamento');await value(work,'#task-due',new Date(Date.now()+3600000).toISOString().slice(0,16));await click(work,'#task-form button');await wait(()=>evaluate(work,`document.querySelector('#task-list').textContent.includes('Responder orçamento')`),'persistent follow-up task');
    await value(work,'#reply-title','Orçamento');await value(work,'#reply-body','Olá! Vou conferir e te retorno.');await click(work,'#reply-form button');await wait(()=>evaluate(work,`document.querySelector('#reply-list').textContent.includes('Vou conferir')`),'saved quick reply');
    await click(work,'#digest');await wait(()=>evaluate(work,`document.querySelector('#digest-result').textContent.includes('Resumo:')`),'loaded conversation summary');
    await screenshot(work,'productivity-workspace');await send('Page.reload',{},work.sessionId);await wait(()=>evaluate(work,`document.querySelector('#task-list').textContent.includes('Responder orçamento') && document.querySelector('#reply-list').textContent.includes('Vou conferir')`),'productivity persistence');
  }
  await click(popup,'#trial');await wait(()=>evaluate(popup,`document.querySelector('#plan-name').textContent==='Trial Pro'`),'14-day trial activated');await screenshot(popup,'popup-trial',420,1200);
  await click(popup,'#subscribe');await wait(()=>stripeCalls.some(c=>c.p==='/checkout/sessions'),'Stripe checkout from real popup');assert.equal(app.store.entitlement(app.store.accountByEmail('demo@example.test')).plan,'trial','redirect is not proof of payment');
  await click(popup,'#logout');await wait(()=>evaluate(popup,`!document.querySelector('#login').hidden`),'logout');assert.equal(await evaluate(popup,`chrome.storage.local.get(null).then(s=>!!s.token||!!s['vault:transcripts'])`),false);
  assert.equal(errors.length,0,JSON.stringify(errors));
  const report={passed:true,browser:binary,flows:['default-off','verified-login','consent-gate','transcription','summary','encrypted-cache','reload','server-quota','trial','checkout-not-entitlement','logout',...(existsSync('extension/workspace.html')?['transcript-search','follow-up','quick-replies','conversation-digest','workspace-persistence']:[])],aiCalls,consoleErrors:errors.length,remaining:'Synthetic WhatsApp DOM and stubbed external providers. Real WhatsApp, live email, real Stripe/OpenRouter and Chrome Store approval require staging/production smoke.'};
  writeFileSync('artifacts/browser-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  if(socket)socket.close();if(chrome){chrome.kill('SIGTERM');await pause(300);chrome.kill('SIGKILL');}
  if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});rmSync(profile,{recursive:true,force:true});
}
