// Real MV3 extension + real HTTP backend; synthetic WhatsApp and external providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
const pause = ms => new Promise(r => setTimeout(r,ms));
async function wait(fn,label) { for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await pause(100);}throw new Error(`Timeout: ${label}`); }
const root=path.resolve(import.meta.dirname,'..');
const binary=process.env.CHROME_BIN||['/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
if(!binary)throw new Error('Chrome não encontrado.');
const profile=mkdtempSync(path.join(tmpdir(),'dia-browser-')), pending=new Map(),errors=[],codes=new Map(),stripeCalls=[];
mkdirSync('artifacts',{recursive:true});
let browser,next=0,aiCalls=0;
const app=createApp(loadConfig({NODE_ENV:'development',DATABASE_PATH:':memory:',DATA_ENCRYPTION_KEY:'ab'.repeat(32),STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_PRICE_ID:'price_pro'}),{
  mail:async(e,c)=>codes.set(e,c),
  ai:async(kind,input)=>{
    aiCalls++;
    if(kind==='assist'&&input.action==='tasks')return {text:JSON.stringify({tasks:[{title:'Enviar orçamento',body:'Prazo mencionado: sexta-feira.',source:'Pode enviar o orçamento até sexta-feira?',owner:'Ana',priority:'high',waitingFor:'me'}]})};
    if(kind==='assist'&&input.action==='decisions')return {text:JSON.stringify({decisions:[{title:'Aprovar piloto',body:'O piloto foi aprovado para segunda-feira.',source:'Decidimos aprovar o piloto para segunda-feira.',owner:'Carla',priority:'high'}]})};
    if(kind==='assist'&&input.action==='risks')return {text:JSON.stringify({risks:[{title:'Cliente bloqueado',body:'O contrato impede o avanço do cliente.',source:'O cliente está bloqueado sem o contrato assinado.',severity:'high'}]})};
    if(kind==='assist'&&input.action==='briefing'){if(input.text.includes('SLOW_PREVIEW'))await pause(400);return {text:'Prioridades: contrato e orçamento.\nDecisões: piloto aprovado.\nRiscos: cliente bloqueado.\nPendências: responder até sexta-feira.'};}
    if(kind==='assist'&&input.action==='handoff')return {text:'Contexto: piloto comercial.\nEstado atual: contrato pendente.\nPróximas ações: enviar orçamento e obter assinatura.'};
    if(kind==='summarize'||(kind==='assist'&&input.action==='catchup'))return {text:'Resumo: confirmar o orçamento e responder até sexta-feira.'};
    if(kind==='assist')return {text:'Olá! Vou verificar o orçamento e confirmar o prazo.'};
    return {text:'Oi! Você consegue me enviar o orçamento até sexta-feira? Obrigado!'};
  },
  triage:async()=>({model:'jev-test',urgency:{score:2.2,confidence:.91},conflict:{score:1.8,confidence:.84},needsResponse:{probability:.93},category:{choice:'revenue',confidence:.88},priority:'high'}),
  stripe:async(p,v)=>{stripeCalls.push({p,v});if(p.startsWith('/prices/'))return {active:true,type:'recurring',recurring:{interval:'month',interval_count:1},unit_amount:2990,currency:'brl'};if(p==='/customers')return {id:'cus_demo'};if(p.startsWith('/subscriptions?'))return {data:[],has_more:false};if(p==='/checkout/sessions')return {id:'cs_demo',status:'open',url:'https://checkout.stripe.com/c/pay/demo'};throw new Error(`Unexpected fake Stripe endpoint ${p}`);}
});
function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},30000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
async function tab(url){const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);if(url)await send('Page.navigate',{url},sessionId);return {targetId,sessionId};}
async function evaluate(t,expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},t.sessionId);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const click=async(t,s)=>{await wait(()=>evaluate(t,`{const e=document.querySelector(${JSON.stringify(s)});!!e&&!e.disabled}`),`enabled ${s}`);return evaluate(t,`document.querySelector(${JSON.stringify(s)}).click()`);};
const value=(t,s,v)=>evaluate(t,`document.querySelector(${JSON.stringify(s)}).value=${JSON.stringify(v)}`);
const text=(t,s,part)=>evaluate(t,`document.querySelector(${JSON.stringify(s)})?.textContent.includes(${JSON.stringify(part)})`);
async function screenshot(t,name,width=1280,height=800){
  await send('Target.activateTarget',{targetId:t.targetId});
  await send('Page.bringToFront',{},t.sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},t.sessionId);await pause(200);
  const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},t.sessionId);
  writeFileSync(`artifacts/${name}.png`,Buffer.from(r.data,'base64'));
}
const fixture=`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>WhatsApp Web | Demonstração</title><style>body{margin:0;background:#efeae2;font:16px system-ui;color:#20352e}aside{position:fixed;width:250px;inset:0 auto 0 0;background:white;padding:25px}main{margin-left:310px;padding:30px}header{background:#fafafa;padding:22px;margin-bottom:24px}.message{background:white;padding:20px;border-radius:12px;max-width:600px;margin:20px 0}small{color:#526d64}footer{position:fixed;bottom:15px;right:25px}</style><aside><h2>Conversas</h2><p>Equipe Comercial</p><small>Dados fictícios para teste</small></aside><main id="main"><header><b title="Equipe Comercial">Equipe Comercial</b><p>Organize o que importa. Sem enviar mensagens automaticamente.</p></header><div class="message" data-id="demo-audio-1" role="row"><div data-pre-plain-text="[09:30, 16/09/2026] Ana: ">Pode enviar o orçamento até sexta-feira?</div><audio controls src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="></audio></div><div class="message" data-id="demo-text-2" role="row"><div data-pre-plain-text="[09:31, 16/09/2026] Bruno: ">Vamos revisar as condições e confirmar o prazo.</div></div><div class="message" data-id="demo-text-3" role="row"><div data-pre-plain-text="[09:32, 16/09/2026] Carla: ">Decidimos aprovar o piloto para segunda-feira.</div></div><div class="message" data-id="demo-text-4" role="row"><div data-pre-plain-text="[09:33, 16/09/2026] Diego: ">O cliente está bloqueado sem o contrato assinado.</div></div></main><footer><div contenteditable="true" role="textbox" aria-label="Digite uma mensagem"></div><button aria-label="Enviar" onclick="globalThis.__sentMessages=(globalThis.__sentMessages||0)+1">Enviar</button><span>Ambiente de demonstração. Conteúdo fictício.</span></footer><script>globalThis.__sentMessages=0</script></html>`;
try {
  await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(43110,'127.0.0.1',r);});
  browser=spawn(binary,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-pipe','--enable-unsafe-extension-debugging','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  browser.stderr.on('data',()=>{});
  let stream='';browser.stdio[4].on('data',bytes=>{stream+=bytes.toString();let i;while((i=stream.indexOf('\0'))>=0){const raw=stream.slice(0,i);stream=stream.slice(i+1);if(!raw)continue;const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Fetch.requestPaused')send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(fixture).toString('base64')},m.sessionId).catch(e=>errors.push(e.message));}});
  await send('Browser.getVersion');
  const {id}=await send('Extensions.loadUnpacked',{path:path.join(root,'extension')}),origin=`chrome-extension://${id}`;
  const popup=await tab(`${origin}/popup.html`);
  await wait(()=>text(popup,'#plan-details','29,90'),'actual price');
  assert.equal(await evaluate(popup,"document.querySelector('#automatic').checked || document.querySelector('#consent').checked"),false);
  await value(popup,'#email','demo@example.test');await click(popup,'#request-form button');await wait(()=>codes.has('demo@example.test'),'email code');await value(popup,'#code',codes.get('demo@example.test'));await click(popup,'#verify-form button');await wait(()=>text(popup,'#identity','demo@example.test'),'verified login');
  const wa=await tab();await send('Fetch.enable',{patterns:[{urlPattern:'https://web.whatsapp.com/*',requestStage:'Request'}]},wa.sessionId);await send('Page.navigate',{url:'https://web.whatsapp.com/'},wa.sessionId);
  await wait(()=>evaluate(wa,"!!document.querySelector('.wpp-transcriber__button')"),'content controls');assert.equal(aiCalls,0);
  await click(wa,'.wpp-transcriber__button');await wait(()=>text(wa,'.wpp-transcriber__text','autorize'),'consent gate');assert.equal(aiCalls,0);
  await click(popup,'#consent');await click(popup,'#save-settings');await wait(()=>text(popup,'#status','salvas'),'save consent');
  await click(wa,'.wpp-transcriber__button');await wait(()=>text(wa,'.wpp-transcriber__text','orçamento até sexta'),'transcription');assert.equal(aiCalls,1);
  await click(wa,'.wpp-transcriber__summary');await wait(()=>text(wa,'.wpp-transcriber__text','Resumo:'),'summary');assert.equal(aiCalls,2);
  await wait(()=>evaluate(popup,"chrome.storage.local.get(null).then(s=>!!s['vault:transcripts'])"),'encrypted persistence');assert.equal(await evaluate(popup,"chrome.storage.local.get(null).then(s=>JSON.stringify(s).includes('orçamento'))"),false);
  await screenshot(wa,'whatsapp-transcription');await click(popup,'#refresh');await wait(()=>text(popup,'#usage','2 de 30'),'server quota');await screenshot(popup,'popup-account',420,1200);
  await send('Page.reload',{},wa.sessionId);await wait(()=>text(wa,'.wpp-transcriber__text','orçamento até sexta'),'cache restored');assert.equal(aiCalls,2);
  const productivity=existsSync(path.join(root,'extension/workspace.html'));
  if(productivity){
    await send('Target.activateTarget',{targetId:wa.targetId});const work=await tab(`${origin}/workspace.html`);
    await wait(()=>text(work,'#library-list','orçamento'),'library');await value(work,'#library-search','inexistente');await evaluate(work,"document.querySelector('#library-search').dispatchEvent(new Event('input'))");await wait(()=>text(work,'#library-list','Nenhum'),'search');
    await value(work,'#library-search','');await evaluate(work,"document.querySelector('#library-search').dispatchEvent(new Event('input'))");
    await click(work,'#storage-consent');
    await click(work,'nav a[href="#tasks-section"]');
    await value(work,'#task-title','Responder orçamento');await value(work,'#task-due',new Date(Date.now()+3600000).toISOString().slice(0,16));
    await value(work,'#task-priority','critical');await value(work,'#task-waiting','me');await value(work,'#task-owner','Marina');await value(work,'#task-folder','Conselho');await value(work,'#task-tags','piloto, receita');
    await click(work,'#task-form button');await wait(()=>text(work,'#task-list','Responder orçamento'),'executive follow-up');
    assert.equal(await text(work,'#task-list','Responsável: Marina'),true);assert.equal(await text(work,'#task-list','Aguardando: Minha ação'),true);assert.equal(await text(work,'#metric-critical','1'),true);
    await value(work,'#reply-title','Orçamento');await value(work,'#reply-body','Olá! Vou conferir e te retorno.');await value(work,'#reply-folder','Modelos');await click(work,'#reply-form button');await wait(()=>text(work,'#reply-list','Vou conferir'),'quick reply');
    await wait(()=>evaluate(work,"[...document.querySelectorAll('#reply-list article button')].every(b=>!b.disabled)"),'reply controls enabled');await evaluate(work,"[...document.querySelectorAll('#reply-list article button')].find(b=>b.textContent==='Editar').click()");await value(work,'#reply-list .edit-form textarea','Olá! Vou conferir os dados e retorno hoje.');await value(work,'#reply-list .edit-form input[list="folder-options"]','Modelos VIP');await click(work,'#reply-list .edit-form button[type="submit"]');await wait(async()=>await text(work,'#reply-list','retorno hoje')&&await text(work,'#reply-list','Modelos VIP'),'edit and move saved item');
    await click(work,'#load-conversation');await wait(()=>evaluate(work,"document.querySelector('#context').value.includes('Pode enviar o orçamento')"),'reviewable conversation capture');
    await value(work,'#context-folder','Crise cliente');
    assert.equal(aiCalls,2);
    await click(work,'#digest');await wait(()=>evaluate(work,"document.querySelector('#digest-result').value.includes('Resumo:')"),'conversation digest');
    await click(work,'#save-digest');await wait(()=>text(work,'#library-list','Resumo:'),'saved digest');
    await click(work,'#extract-tasks');await wait(()=>text(work,'#extracted-tasks','Evidência:'),'task extraction');
    await click(work,'#extracted-tasks button');await wait(()=>text(work,'#task-list','Enviar orçamento'),'reviewed task saved');
    await click(work,'#extract-decisions');await wait(()=>text(work,'#extracted-decisions','Evidência:'),'decision extraction evidence');
    await click(work,'#extracted-decisions button');await wait(()=>text(work,'#decision-list','Aprovar piloto'),'reviewed decision saved');
    await click(work,'#extract-risks');await wait(()=>text(work,'#extracted-risks','Evidência:'),'risk extraction evidence');
    await click(work,'#extracted-risks button');await wait(()=>text(work,'#risk-list','Cliente bloqueado'),'reviewed risk saved');
    await click(work,'#generate-briefing');await wait(()=>evaluate(work,"document.querySelector('#briefing-result').value.includes('Prioridades:')"),'executive briefing');
    await click(work,'#save-briefing');await wait(()=>text(work,'#library-list','piloto aprovado'),'saved executive briefing');
    await click(work,'#generate-handoff');await wait(()=>evaluate(work,"document.querySelector('#handoff-result').value.includes('Contexto:')"),'delegation handoff');
    await evaluate(work,"Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{globalThis.__copied=value}}})");
    await click(work,'#copy-handoff');await wait(()=>evaluate(work,"globalThis.__copied?.includes('Próximas ações:')"),'handoff copy-only');
    await click(work,'#save-handoff');await wait(()=>text(work,'#library-list','contrato pendente'),'saved handoff');
    await click(work,'#jev-triage');await wait(()=>text(work,'#triage-box','Receita'),'Jev triage rendered');
    await click(work,'#save-triage');await wait(()=>text(work,'#risk-list','Sinal de atenção'),'reviewed Jev triage saved');
    assert.equal(await evaluate(wa,'globalThis.__sentMessages'),0,'ações executivas não podem enviar mensagens');
    await click(work,'#prepare-saved-briefing');await wait(()=>evaluate(work,"document.querySelector('#briefing-source-preview').value.includes('Responder orçamento')"),'cross-conversation briefing preview');
    const oversized=await evaluate(work,"chrome.runtime.sendMessage({type:'workspace:init'}).then(async s=>{const make=(title,body,priority)=>({id:crypto.randomUUID(),revision:0,kind:'risk',title,body,conversation:'Teste sintético',folder:'Limite',priority,waitingFor:'none',owner:'',source:'',tags:[],confidence:'',dueAt:'',done:false,archived:false});await chrome.runtime.sendMessage({type:'workspace:save',context:s.context,storageConsent:true,item:make('Item pequeno que deve entrar','conteúdo curto','normal')});await chrome.runtime.sendMessage({type:'workspace:save',context:s.context,storageConsent:true,item:make('Item grande omitido','x'.repeat(32000),'critical')});return true})");assert.equal(oversized,true);await click(work,'#refresh');await wait(()=>text(work,'#risk-list','Item grande omitido'),'oversized item saved');await value(work,'#briefing-folder','Limite');await click(work,'#prepare-saved-briefing');await wait(()=>evaluate(work,"document.querySelector('#briefing-source-preview').value.includes('Item pequeno que deve entrar')"),'briefing skips oversized whole item');assert.equal(await evaluate(work,"document.querySelector('#briefing-source-preview').value.includes('Item grande omitido')"),false);
    await value(work,'#briefing-source-preview','SLOW_PREVIEW');await evaluate(work,"document.querySelector('#briefing-source-preview').dispatchEvent(new Event('input'))");await click(work,'#run-saved-briefing');await value(work,'#briefing-source-preview','PREVIEW_CHANGED');await evaluate(work,"document.querySelector('#briefing-source-preview').dispatchEvent(new Event('input'))");await wait(()=>text(work,'#status','prévia mudou'),'stale briefing result rejected');
    await click(work,'#draft-reply');await wait(()=>evaluate(work,"document.querySelector('#reply-body').value.includes('Vou verificar')"),'AI draft');
    await value(work,'#library-search','piloto');await evaluate(work,"document.querySelector('#library-search').dispatchEvent(new Event('input'))");
    await value(work,'#filter-folder','Conselho');await evaluate(work,"document.querySelector('#filter-folder').dispatchEvent(new Event('change'))");
    await value(work,'#filter-kind','task');await evaluate(work,"document.querySelector('#filter-kind').dispatchEvent(new Event('change'))");
    await value(work,'#filter-priority','critical');await evaluate(work,"document.querySelector('#filter-priority').dispatchEvent(new Event('change'))");
    await wait(()=>text(work,'#library-list','Responder orçamento'),'combined search and folder filters');assert.equal(await text(work,'#library-list','Enviar orçamento'),false);
    await value(work,'#library-search','');await value(work,'#filter-folder','');await value(work,'#filter-kind','');await value(work,'#filter-priority','');await evaluate(work,"['library-search','filter-folder','filter-kind','filter-priority'].forEach(id=>document.querySelector('#'+id).dispatchEvent(new Event(id==='library-search'?'input':'change')))");
    await screenshot(work,'productivity-actions');
    await evaluate(work,"window.scrollTo(0,0)");await screenshot(work,'productivity-workspace');
    await evaluate(work,"document.querySelector('#library-section').scrollIntoView()");await screenshot(work,'productivity-library');
    await evaluate(work,"window.scrollTo(0,0)");await screenshot(work,'productivity-mobile',390,844);
    assert.equal(await evaluate(work,"document.documentElement.scrollWidth<=window.innerWidth"),true);
    const exported=await evaluate(work,"chrome.runtime.sendMessage({type:'workspace:init'}).then(async s=>chrome.runtime.sendMessage({type:'workspace:export',context:s.context}))");
    assert.equal(exported.workspace.length,11);const executiveTask=exported.workspace.find(item=>item.title==='Responder orçamento');assert.deepEqual({priority:executiveTask.priority,waitingFor:executiveTask.waitingFor,owner:executiveTask.owner,folder:executiveTask.folder,tags:executiveTask.tags},{priority:'critical',waitingFor:'me',owner:'Marina',folder:'Conselho',tags:['piloto','receita']});const editedReply=exported.workspace.find(item=>item.title==='Orçamento');assert.equal(editedReply.folder,'Modelos VIP');assert.match(editedReply.body,/retorno hoje/);assert.ok(exported.workspace.some(item=>item.title.includes('Sinal de atenção')&&item.tags.includes('jev')));
    await send('Page.reload',{},work.sessionId);await wait(async()=>await text(work,'#task-list','Responsável: Marina')&&await text(work,'#decision-list','Aprovar piloto')&&await text(work,'#risk-list','Cliente bloqueado')&&await text(work,'#library-list','contrato pendente'),'executive workspace persistence');
  }
  await click(popup,'#trial');await wait(()=>text(popup,'#plan-name','Trial Pro'),'trial');await screenshot(popup,'popup-trial',420,1200);
  await click(popup,'#subscribe');await wait(()=>stripeCalls.some(c=>c.p==='/checkout/sessions'),'checkout');assert.equal(app.store.entitlement(app.store.accountByEmail('demo@example.test')).plan,'trial');
  assert.equal(await evaluate(wa,'globalThis.__sentMessages'),0,'a extensão não pode enviar mensagens no WhatsApp');
  await click(popup,'#logout');await wait(()=>evaluate(popup,"!document.querySelector('#login').hidden"),'logout');assert.equal(await evaluate(popup,"chrome.storage.local.get(null).then(s=>!!s.token || !!s['vault:transcripts'])"),false);
  assert.equal(errors.length,0,JSON.stringify(errors));
  const report={passed:true,browser:binary,flows:['default-off','verified-login','consent-gate','transcription','summary','encrypted-cache','reload','server-quota','trial','checkout-not-entitlement','logout','no-whatsapp-send',...(productivity?['transcript-search','executive-dashboard','follow-up-metadata','quick-replies','item-edit-and-move','conversation-capture-preview','conversation-digest','task-extraction-evidence','decision-extraction-evidence','risk-extraction-evidence','executive-briefing','handoff-copy-only','Jev-triage','triage-save','cross-conversation-briefing','oversized-briefing-item-skip','stale-briefing-rejection','AI-reply-draft','combined-search-filters','workspace-export','mobile-no-overflow','executive-persistence']:[])],aiCalls,consoleErrors:errors.length,remaining:'Synthetic WhatsApp; external email/Stripe/OpenRouter/TypeSafe stubbed. Real services, real WhatsApp and store approval require production smoke.'};
  writeFileSync('artifacts/browser-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  if(browser){browser.stdio[3].end();browser.kill('SIGTERM');await pause(300);browser.kill('SIGKILL');}
  await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});rmSync(profile,{recursive:true,force:true});
}
