import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from '../src/store.js';
import { createAutomationService } from '../src/automations.js';
import { createApp } from '../src/server.js';
import { acceptClientUpdate } from '../src/client-bot.js';
import { flushOutbox } from '../src/bot.js';
const leadInput={name:'Анна',contact:'@anna',request:'Сайт',budget:2000};
const rule=(overrides={})=>({name:'Тестовый сценарий',enabled:true,trigger:'lead.created',mode:'all',conditions:[],actions:[{type:'tag',value:'авто'}],...overrides});
async function fixture(path){const store=openStore(path);const user=await store.register({username:'admin_test',password:'password-123'},true);const auto=createAutomationService(store);return {store,user,auto};}

test('event rules match AND/OR filters, execute ordered actions once, suppress recursive events',async()=>{
 const {store,user,auto}=await fixture();try{
  auto.save(rule({conditions:[{field:'budget',op:'gte',value:1000},{field:'source',op:'eq',value:'manual'}],actions:[{type:'stage',value:'working'},{type:'task',value:'Позвонить {{name}}',minutes:30},{type:'team',value:'{{name}}: {{budget}}'}]}),user);
  auto.save(rule({trigger:'lead.stage',actions:[{type:'tag',value:'recursive'}]}),user);
  const lead=store.create({...leadInput,owner_id:user.id});store.create({...leadInput,name:'Бюджетный',budget:100});
  for(let i=0;i<5;i++)auto.tick();
  assert.equal(store.get(lead.id).status,'working');assert.equal(store.tasks().length,1);assert.equal(store.tasks()[0].title,'Позвонить Анна');assert.equal(store.tasks()[0].assignee_id,user.id);assert.ok(store.tasks()[0].remind_at);assert.equal(store.messages(user,'team',null).length,1);
  assert.equal(auto.runs().filter(r=>r.state==='done').length,1);assert.equal(auto.runs().filter(r=>r.state==='skipped').length,1);assert.deepEqual(store.get(lead.id).tags,[]);
  assert.equal(auto.preview(rule({mode:'any',conditions:[{field:'budget',op:'gte',value:5000},{field:'name',op:'contains',value:'анн'}]}),lead.id).matches,true);
 }finally{store.close();}
});

test('pause and next step survive database restart, completed steps are not repeated',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jumpads-auto-')),path=join(dir,'crm.sqlite');let store;
 try{
  const f=await fixture(path);store=f.store;f.auto.save(rule({actions:[{type:'team',value:'Первый'},{type:'wait',minutes:5},{type:'team',value:'Последний'}]}),f.user);store.create(leadInput);
  const now=new Date(Date.now()+1000).toISOString();f.auto.tick(now);f.auto.tick(now);assert.equal(f.auto.runs()[0].step,2);store.close();
  store=openStore(path);const auto=createAutomationService(store);auto.tick(now);assert.equal(store.messages(f.user,'team',null).length,1);
  auto.tick(new Date(Date.parse(now)+5*60000).toISOString());auto.tick(new Date(Date.parse(now)+6*60000).toISOString());assert.equal(auto.runs()[0].state,'done');assert.equal(store.messages(f.user,'team',null).length,2);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed step is atomic, paid stage cannot be forged, disabled and revoked-owner runs stop',async()=>{
 const {store,user,auto}=await fixture();try{
  const r=auto.save(rule({actions:[{type:'stage',value:'paid'},{type:'tag',value:'should-not-run'}]}),user);const lead=store.create(leadInput);auto.tick();assert.equal(auto.runs()[0].state,'failed');assert.match(auto.runs()[0].error,/банком/);assert.equal(store.get(lead.id).status,'new');assert.deepEqual(store.get(lead.id).tags,[]);assert.equal(store.db.prepare('SELECT active FROM automation_context').get().active,0);
  const waiting=auto.save(rule({trigger:'manual',actions:[{type:'wait',minutes:5},{type:'team',value:'Не отправлять'}]}),user);auto.manual(waiting.id,lead.id,'manual-key-123');auto.tick();auto.save({...waiting,enabled:false},user,waiting.id);assert.equal(auto.runs().find(r=>r.rule_id===waiting.id).state,'canceled');
  const revoked=auto.save(rule({trigger:'manual'}),user);auto.manual(revoked.id,lead.id,'manual-key-124');store.setRole(user.id,'observer');auto.tick();assert.equal(auto.runs().find(r=>r.rule_id===revoked.id).state,'failed');assert.deepEqual(store.get(lead.id).tags,[]);
 }finally{store.close();}
});

test('task completion, client join and confirmed-payment events are durably captured',async()=>{
 const {store,user,auto}=await fixture();try{
  for(const trigger of ['client.joined','task.done','payment.confirmed'])auto.save(rule({name:trigger,trigger,actions:[{type:'team',value:trigger+': {{name}}'}]}),user);
  ['/start','Лена','@lena','Нужен сайт'].forEach((text,i)=>acceptClientUpdate(store,{update_id:i+1,message:{chat:{id:75,type:'private'},from:{id:75,first_name:'Лена'},text}}));
  const lead=store.list()[0],task=store.saveTask({title:'Задача',lead_id:lead.id},user);store.saveTask({status:'done'},user,task.id);store.saveTask({status:'done'},user,task.id);
  // The payment trigger observes the same persisted transition that the signed bank callback writes.
  const now=new Date().toISOString();store.db.prepare('INSERT INTO payments(id,lead_id,order_id,terminal_key,mode,amount,description,status,created_at,updated_at,created_by,request_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('p1',lead.id,'o1','demo','demo',100,'Test','NEW',now,now,user.id,'pay-key');
  store.db.prepare("UPDATE payments SET status='CONFIRMED' WHERE id='p1'").run();store.db.prepare("UPDATE payments SET status='CONFIRMED' WHERE id='p1'").run();auto.tick();auto.tick();assert.equal(auto.runs().length,3);assert.equal(auto.runs().filter(r=>r.state==='done').length,3);assert.equal(store.messages(user,'team',null).length,3);
 }finally{store.close();}
});

test('client automation respects opt-out at delivery and manual keys deduplicate',async()=>{
 const {store,user,auto}=await fixture();try{
  ['/start','Клиент','@client99','Вопрос'].forEach((text,i)=>acceptClientUpdate(store,{update_id:i+1,message:{chat:{id:99,type:'private'},from:{id:99,first_name:'Клиент'},text}}));const lead=store.list()[0];await flushOutbox(store,async()=>{},'client_bot');
  const r=auto.save(rule({trigger:'manual',actions:[{type:'client',value:'Здравствуйте, {{name}}'}]}),user);
  const first=auto.manual(r.id,lead.id,'unique-run-123'),second=auto.manual(r.id,lead.id,'unique-run-123');assert.equal(first.id,second.id);auto.tick();assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='client_bot'").get().n,1);
  store.db.prepare('UPDATE client_members SET notifications_enabled=0 WHERE chat_id=?').run('99');let delivered=0;await flushOutbox(store,async()=>{delivered++;},'client_bot');assert.equal(delivered,0);assert.equal(store.db.prepare("SELECT delivery FROM messages WHERE client_key LIKE 'automation:%'").get().delivery,'canceled');
 }finally{store.close();}
});

test('new rules do not replay historical events and malformed actions are rejected',async()=>{
 const {store,user,auto}=await fixture();try{
  store.transaction(()=>{for(let i=0;i<510;i++)store.create({...leadInput,contact:'@'+i});});auto.save(rule(),user);auto.tick();assert.equal(auto.runs().length,0);
  assert.throws(()=>auto.save(rule({actions:[{type:'eval',value:'code'}]}),user),/Неизвестное/);assert.throws(()=>auto.save(rule({actions:[{type:'wait',minutes:-1}]}),user),/Время/);
 }finally{store.close();}
});

test('condition check after a delay stops outdated follow-ups',async()=>{
 const {store,user,auto}=await fixture();try{
  const lead=store.create({...leadInput,status:'proposal'});
  const r=auto.save(rule({trigger:'manual',conditions:[{field:'status',op:'eq',value:'proposal'}],actions:[{type:'wait',minutes:1},{type:'check'},{type:'task',value:'Не создавать',minutes:30}]}),user);
  auto.manual(r.id,lead.id,'follow-up-key');auto.tick();store.update(lead.id,{status:'won'});const later=new Date(Date.now()+120000).toISOString();auto.tick(later);auto.tick(later);
  assert.equal(auto.runs()[0].state,'skipped');assert.equal(store.tasks().length,0);assert.match(auto.runs()[0].logs.at(-1).detail,/больше не совпадают/);
 }finally{store.close();}
});

test('automation API is admin-only; saved kanban filters are private per user',async()=>{
 const store=openStore();const server=createApp({store,requireTelegram:false});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,method='GET',data,cookie='')=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 try{
  const a=await call('/api/register','POST',{username:'admin',password:'password-123'}),b=await call('/api/register','POST',{username:'viewer',password:'password-123',role:'observer'});
  assert.equal((await call('/api/automations','POST',rule(),b.cookie)).status,403);assert.equal((await call('/api/automations','GET',null,b.cookie)).status,403);assert.equal((await call('/api/automations','POST',rule(),a.cookie)).status,200);
  const filter=await call('/api/kanban-views','POST',{name:'Мои лиды',filters:{owner:a.body.user.id}},a.cookie);assert.equal(filter.status,201);assert.equal((await call('/api/kanban-views','GET',null,b.cookie)).body.length,0);await call('/api/kanban-views/'+filter.body.id,'DELETE',{},b.cookie);assert.equal((await call('/api/kanban-views','GET',null,a.cookie)).body.length,1);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
