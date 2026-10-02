import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openStore } from '../src/store.js';
import { createPaymentService,bankToken } from '../src/payments.js';
import { acceptClientUpdate,clientDetails,createInvite,campaignPreview,sendCampaign } from '../src/client-bot.js';
import { acceptUpdate,flushOutbox } from '../src/bot.js';
import { createApp } from '../src/server.js';
const config={terminalKey:'UnitTestDEMO',password:'secret-not-real',mode:'demo',publicUrl:'https://crm.example.test',taxation:'',tax:''};
const actor={id:'test-admin',username:'admin',role:'admin'};
const invoice=()=>({amount:'123.45',description:'Тестовая услуга',clientRequestId:randomUUID(),remind_at:new Date(Date.now()-1000).toISOString()});
function client(store,id,text,user=77,extra={}){acceptClientUpdate(store,{update_id:id,message:{chat:{id:user,type:'private',first_name:'Анна'},from:{id:user,is_bot:false,first_name:'Анна',last_name:'Иванова',username:'anna',language_code:'ru',is_premium:true},text,...extra}});}
function enroll(store,firstId,user=77){['/start','Анна',`@client${user}`,'Нужен сайт'].forEach((text,i)=>client(store,firstId+i,text,user));return store.list().find(l=>l.client_chat_id===String(user));}
function transport(){let seq=100,requests=[];const states=new Map();return {requests,states,async call(method,payload){requests.push({method,payload});if(method==='Init'){const result={Success:true,ErrorCode:'0',TerminalKey:payload.TerminalKey,OrderId:payload.OrderId,PaymentId:String(++seq),Amount:payload.Amount,Status:'NEW',PaymentURL:'https://securepay.tinkoff.ru/test/'+seq};states.set(result.PaymentId,result);return result;}return states.get(payload.PaymentId);}};}
const signed=(p,status,extra={})=>{const data={TerminalKey:p.terminal_key,OrderId:p.order_id,PaymentId:p.bank_payment_id??'501',Amount:p.amount,Success:true,ErrorCode:'0',Status:status,...extra};return {...data,Token:bankToken(data,config.password)};};
test('T-Bank signature matches official UTF-8 test vector and ignores nested fields',()=>{
 const data={TerminalKey:'MerchantTerminalKey',Amount:19200,OrderId:'00000',Description:'Подарочная карта на 1000 рублей',DATA:{Phone:'ignored'},Receipt:{Email:'ignored'}};
 assert.equal(bankToken(data,'11111111111111'),'72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2');
});
test('client bot collects a request step by step into one lead with available metadata; team bot turns strangers away',async()=>{
 const s=openStore();try{
  acceptUpdate(s,{update_id:999,message:{chat:{id:88,type:'private'},from:{id:88},text:'/start'}});assert.match(s.db.prepare("SELECT text FROM outbox WHERE kind='telegram'").get().text,/команды/);
  client(s,1,'/start');client(s,1,'/start');assert.equal(s.list().length,0);client(s,2,'Анна');client(s,3,'@anna');client(s,4,'Нужен лендинг');assert.equal(s.list().length,1);const lead=s.list()[0];assert.equal(lead.source,'telegram');assert.deepEqual(lead.tags,['telegram']);assert.equal(lead.client_chat_id,'77');assert.equal(clientDetails(s,lead.id).profile.is_premium,true);
  client(s,5,'Уточнение');assert.equal(s.list().length,1);assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='offset'").get().value,'1000');assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='client_offset'").get().value,'6');
 }finally{s.close();}
});
test('own contact only, request from the dialog, opt-out and invites cannot hijack another customer',()=>{
 const s=openStore();try{const id=enroll(s,1).id;assert.equal(s.get(id).request,'Нужен сайт');client(s,5,'',77,{contact:{user_id:78,phone_number:'+70000000000'}});assert.equal(clientDetails(s,id).contact_profile,null);client(s,6,'',77,{contact:{user_id:77,phone_number:'+79991112233',first_name:'Анна',vcard:'TEST'}});assert.equal(s.get(id).contact,'+79991112233');assert.equal(clientDetails(s,id).contact_profile.vcard,'TEST');assert.equal(s.list().length,1);
 client(s,7,'/subscribe');assert.equal(clientDetails(s,id).broadcast_enabled,1);client(s,8,'/stop');assert.equal(clientDetails(s,id).notifications_enabled,0);
 const manual=s.create({name:'Борис',contact:'@boris',request:'Работа'});const invite=createInvite(s,manual.id,'clients_bot');const payload=new URL(invite.url).searchParams.get('start');client(s,9,'/start '+payload,90);assert.equal(s.get(manual.id).client_chat_id,'90');assert.equal(s.list().length,2);client(s,10,'/start '+payload,91);assert.equal(s.get(manual.id).client_chat_id,'90');assert.equal(s.list().length,2);assert.match(s.db.prepare("SELECT text FROM outbox WHERE kind='client_bot' AND chat_id='91'").get().text,/недействительна/);
 }finally{s.close();}
});
test('payment init signs exact kopeks, creates one order, isolates client bot delivery',async()=>{
 const s=openStore();try{const lead=enroll(s,1),bank=transport(),service=createPaymentService(s,config,bank.call);const data=invoice();const [a,b]=await Promise.all([service.create(lead.id,data,actor),service.create(lead.id,data,actor)]);assert.equal(a.id,b.id);assert.equal(service.list(lead.id).length,1);assert.equal(bank.requests.length,1);const init=bank.requests[0].payload;assert.equal(init.Amount,12345);assert.equal(init.Token,bankToken(init,config.password));assert.equal(init.NotificationURL,'https://crm.example.test/webhooks/tbank');assert.equal(init.PayType,'O');assert.equal(init.Password,undefined);assert.equal(a.status,'NEW');assert.match(a.payment_url,/securepay/);
 await assert.rejects(service.create(lead.id,invoice(),actor),/незавершённый/);const sent=[];await flushOutbox(s,async(...args)=>sent.push(args));assert.equal(sent.length,0);await flushOutbox(s,async(method,p)=>sent.push(p),'client_bot');assert.ok(sent.some(p=>p.text?.includes('https://securepay')));assert.equal(s.get(lead.id).paid,0);
 }finally{s.close();}
});
test('signed payment confirmation validates identity and amount; duplicates and stale events cannot double count or undo refund',async()=>{
 const s=openStore();try{const lead=enroll(s,1),bank=transport(),service=createPaymentService(s,config,bank.call);const owner=await s.register({username:'pay_owner',password:'test-password',telegram:'@pay_owner'},true);s.staffByTelegram({id:4242,username:'pay_owner'});s.update(lead.id,{owner_id:owner.id},owner.id);const p=await service.create(lead.id,invoice(),actor);
 assert.throws(()=>service.webhook({...signed(p,'CONFIRMED'),Token:'0'.repeat(64)}),/подпись/);assert.throws(()=>service.webhook(signed(p,'CONFIRMED',{Amount:1})),/Сумма/);assert.throws(()=>service.webhook(signed(p,'CONFIRMED',{PaymentId:'9999'})),/соответствует/);assert.throws(()=>service.webhook(signed(p,'CONFIRMED',{Success:false})),/не подтверждена/);
 service.webhook(signed(p,'AUTHORIZED'));assert.equal(s.get(lead.id).paid,0);service.webhook(signed(p,'CONFIRMED'));service.webhook(signed(p,'CONFIRMED'));service.webhook(signed(p,'AUTHORIZED'));assert.equal(s.get(lead.id).status,'paid');assert.equal(s.get(lead.id).paid,1);assert.equal(s.get(lead.id).paid_amount,12345);assert.equal(s.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='telegram' AND chat_id='4242' AND text LIKE ?").get('%Оплата подтверждена%').n,1);assert.equal(s.db.prepare("SELECT count(*) AS n FROM messages WHERE client_key=?").get(`payment:${p.id}:CONFIRMED`).n,1);
 service.webhook(signed(p,'REFUNDED'));service.webhook(signed(p,'CONFIRMED'));assert.equal(s.get(lead.id).paid,0);assert.equal(s.get(lead.id).status,'proposal');
 }finally{s.close();}
});
test('uncertain Init never repeats the financial request and signed webhook recovers the order',async()=>{
 const s=openStore();try{const lead=s.create({name:'Клиент',contact:'@client',request:'Тест'});let calls=0;const service=createPaymentService(s,config,async()=>{calls++;throw new Error('timeout');}),data=invoice();await assert.rejects(service.create(lead.id,data,actor),/не получен/);const p=await service.create(lead.id,data,actor);assert.equal(p.status,'INIT_UNKNOWN');assert.equal(calls,1);await assert.rejects(service.create(lead.id,invoice(),actor),/незавершённый/);service.webhook(signed(p,'CONFIRMED'));assert.equal(s.get(lead.id).paid,1);assert.equal(service.get(p.id).bank_payment_id,'501');}finally{s.close();}
});
test('unpaid reminder is once-only and canceled if paid before delivery',async()=>{
 const s=openStore();try{enroll(s,1);const bank=transport(),service=createPaymentService(s,config,bank.call);const p=await service.create(s.list()[0].id,invoice(),actor);service.tick();service.tick();assert.equal(s.db.prepare('SELECT count(*) AS n FROM messages WHERE client_key=?').get(`payment-reminder:${p.id}`).n,1);service.webhook(signed(p,'CONFIRMED'));const sent=[];await flushOutbox(s,async(method,payload)=>sent.push(payload.text),'client_bot');assert.ok(!sent.some(t=>t.includes('ещё не оплачен')));}finally{s.close();}
});
test('broadcast preview excludes non-subscribers, confirm is idempotent, unsubscribe cancels queued message',async()=>{
 const s=openStore();try{enroll(s,1);enroll(s,5,78);client(s,9,'/subscribe');const preview=campaignPreview(s,actor,{body:'Новости агентства'});assert.equal(preview.count,1);assert.equal(sendCampaign(s,actor,preview.id).queued,1);assert.equal(sendCampaign(s,actor,preview.id).alreadySent,true);client(s,10,'/unsubscribe');const sent=[];await flushOutbox(s,async(method,p)=>sent.push(p.text),'client_bot');assert.ok(!sent.some(t=>t.startsWith('Новости')));assert.equal(s.db.prepare("SELECT delivery FROM messages WHERE client_key=?").get(`campaign:${preview.id}:77`).delivery,'canceled');}finally{s.close();}
});
test('test configuration refuses a live terminal on production endpoint',()=>{
 const s=openStore();try{assert.equal(createPaymentService(s,{...config,terminalKey:'RealTerminal'}).status().configured,false);assert.equal(createPaymentService(s,{...config,mode:'production'}).status().configured,false);assert.equal(createPaymentService(s,{...config,mode:'sandbox',terminalKey:'RealTerminal'}).status().configured,true);}finally{s.close();}
});
test('HTTP webhook needs no CRM session, returns exact OK, return page cannot mark paid; observer cannot invoice or broadcast',async()=>{
 const s=openStore(),bank=transport();const app=createApp({store:s,testRoles:true,paymentsConfig:config,bankTransport:bank.call,clientBotStatus:{state:'connected',username:'client_test_bot'}});app.listen(0,'127.0.0.1');await once(app,'listening');const base=`http://127.0.0.1:${app.address().port}`;let cookie='';const request=async(path,data,method='POST',withCookie=true)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(withCookie?{cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});
 try{
 const register=await request('/api/register',{username:'admin',password:'test-password',telegram:'@admin_tg'});cookie=register.headers.get('set-cookie').split(';')[0];const lead=enroll(s,1);const created=await request(`/api/leads/${lead.id}/payments`,invoice());assert.equal(created.status,201);const p=await created.json();await request('/payment/result?Success=true',undefined,'GET',false);assert.equal(s.get(lead.id).paid,0);
 const notice=await request('/webhooks/tbank',signed(p,'CONFIRMED'),'POST',false);assert.equal(notice.status,200);assert.equal(await notice.text(),'OK');assert.equal(s.get(lead.id).status,'paid');
 await request('/api/me/role',{role:'observer'},'PATCH');assert.equal((await request(`/api/leads/${lead.id}/payments`,invoice())).status,403);assert.equal((await request('/api/campaigns/preview',{body:'Рассылка'})).status,403);assert.equal((await request(`/api/leads/${lead.id}/client`,undefined,'GET')).status,200);
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r));s.close();}
});

test('client bot links a request left in the former intake bot by Telegram ID; blocked client bot does not consume team outbox',async()=>{
 const s=openStore();try{
  const lead=s.create({name:'Анна',contact:'@anna',request:'Запрос',tags:['telegram'],telegram_chat_id:'77'},'telegram');s.queueStaff('500','Уведомление команде');s.queueStaff('501','Ещё уведомление');client(s,1,'/start');assert.equal(s.list().length,1);assert.equal(clientDetails(s,lead.id).user_id,'77');
  await flushOutbox(s,async()=>{const e=new Error('blocked');e.code=403;throw e;},'client_bot');assert.equal(clientDetails(s,lead.id).blocked,1);assert.equal(s.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='telegram'").get().n,2);const messages=[];await flushOutbox(s,async(method,p)=>messages.push(p));assert.equal(messages.length,2);
 }finally{s.close();}
});

test('without APP_PUBLIC_URL the tunnel address reported by the watchdog is used; polling confirms a payment whose notification was lost',async()=>{
 const s=openStore();try{
  const lead=enroll(s,1),bank=transport(),service=createPaymentService(s,{...config,publicUrl:''},bank.call);
  assert.equal(service.status().configured,false);assert.match(service.status().issues.join(),/APP_PUBLIC_URL/);
  s.db.prepare("INSERT OR REPLACE INTO meta VALUES ('public_url',?)").run('https://abc.lhr.life');assert.equal(service.status().configured,true);
  const p=await service.create(lead.id,invoice(),actor);assert.equal(bank.requests[0].payload.NotificationURL,'https://abc.lhr.life/webhooks/tbank');
  // The bank confirmed while its notification went to an address the tunnel has already left.
  bank.states.get(p.bank_payment_id).Status='CONFIRMED';await service.pollPending();
  assert.equal(service.get(p.id).status,'CONFIRMED');assert.equal(s.get(lead.id).paid,1);assert.equal(s.get(lead.id).status,'paid');
 }finally{s.close();}
});

test('a bank that cannot be reached at all leaves no uncertain invoice, so it can be created again',async()=>{
 const s=openStore();try{
  const lead=s.create({name:'Клиент',contact:'@client',request:'Тест'});let calls=0;
  const service=createPaymentService(s,config,async()=>{calls++;throw Object.assign(new Error('connect timeout'),{code:'ETIMEDOUT',notSent:true});});
  await assert.rejects(service.create(lead.id,invoice(),actor),/соединение не установлено/);assert.equal(service.list(lead.id)[0].status,'INIT_FAILED');
  await assert.rejects(service.create(lead.id,invoice(),actor),/соединение не установлено/);assert.equal(calls,2);
 }finally{s.close();}
});
