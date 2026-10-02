import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { createPaymentService,bankToken } from '../src/payments.js';
import { acceptClientUpdate } from '../src/client-bot.js';

test('lead deletion needs admin and confirmation, hides from all lists and cannot be reversed by archive API',async()=>{
 const store=openStore(),app=createApp({store,requireTelegram:false});app.listen(0,'127.0.0.1');await once(app,'listening');
 const user=await store.register({username:'admin_delete',password:'test-password'},true),cookie='session='+store.session(user),base=`http://127.0.0.1:${app.address().port}`;
 const call=(path,method='GET',data)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});
 try{
  const lead=store.create({name:'Удалить',contact:'@delete',request:'Тест'}),task=store.saveTask({title:'Связанная задача',lead_id:lead.id},user);
  store.setRole(user.id,'manager');assert.equal((await call('/api/leads/'+lead.id,'DELETE',{confirm:true})).status,403);
  store.setRole(user.id,'admin');assert.equal((await call('/api/leads/'+lead.id,'DELETE',{})).status,400);assert.equal(store.list().length,1);
  assert.equal((await call('/api/leads/'+lead.id,'DELETE',{confirm:true})).status,200);assert.equal((await call('/api/leads/'+lead.id,'DELETE',{confirm:true})).status,200);
  assert.deepEqual(await(await call('/api/leads')).json(),[]);assert.ok(store.get(lead.id).deleted_at);assert.equal(store.get(lead.id).archived,1);assert.ok(store.task(task.id));
  assert.equal((await call('/api/leads/'+lead.id+'/archive','PATCH',{archived:false})).status,404);assert.equal((await call('/api/leads/'+lead.id,'PATCH',{name:'Вернуть'})).status,404);
  assert.throws(()=>store.update(lead.id,{name:'Вернуть'}),/удалён/);assert.equal(store.duplicates(lead).length,0);
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r));store.close();}
});

test('signed late payment is reconciled after deletion without resurrecting the card',async()=>{
 const store=openStore();try{
  const config={terminalKey:'TestDEMO',password:'secret',mode:'demo',publicUrl:'https://crm.example.test'};
  const service=createPaymentService(store,config,async(method,p)=>({Success:true,ErrorCode:'0',TerminalKey:p.TerminalKey,OrderId:p.OrderId,Amount:p.Amount,PaymentId:'9901',Status:'NEW',PaymentURL:'https://pay.tbank-online.com/test'}));
  const lead=store.create({name:'Клиент',contact:'@client',request:'Сайт'}),payment=await service.create(lead.id,{amount:'100',description:'Тест',clientRequestId:'delete-test-123'},{id:'admin',username:'admin'});
  store.remove(lead.id,'admin');
  const data={Success:true,ErrorCode:'0',TerminalKey:config.terminalKey,OrderId:payment.order_id,PaymentId:payment.bank_payment_id,Amount:10000,Status:'CONFIRMED'};data.Token=bankToken(data,config.password);service.webhook(data);
  assert.equal(service.get(payment.id).status,'CONFIRMED');assert.equal(store.get(lead.id).paid,1);assert.equal(store.list().length,0);assert.ok(store.get(lead.id).deleted_at);
 }finally{store.close();}
});

test('client bot handles a deleted card and accepts a new request instead of reviving it',()=>{
 const store=openStore();try{
  let update=0;const send=text=>acceptClientUpdate(store,{update_id:++update,message:{chat:{id:777,type:'private'},from:{id:777,first_name:'Клиент'},text}});
  for(const t of ['/start','Имя','@contact','Запрос'])send(t);
  const old=store.list()[0];store.remove(old.id,'admin');send('/payments');for(const t of ['/start','Новое имя','@contact','Новый запрос'])send(t);
  assert.equal(store.list().length,1);assert.notEqual(store.list()[0].id,old.id);assert.ok(store.get(old.id).deleted_at);
 }finally{store.close();}
});
