import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { flushOutbox } from '../src/bot.js';
import { acceptClientUpdate } from '../src/client-bot.js';
const password='Test-password-2026';
async function fixture(testRoles=true){
 const store=openStore();const server=createApp({store,testRoles,requireTelegram:false,botStatus:{state:'connected'},clientBotStatus:{state:'connected'}});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const client=()=>{let cookie='';return {get cookie(){return cookie;},async call(path,method='GET',data){const res=await fetch(base+path,{method,headers:{cookie,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await res.json();if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,body};}};};
 return {store,client,base,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}};
}
const lead=(contact='@customer')=>({name:'Клиент',contact,request:'Нужен сайт',tags:['VIP'],clientRequestId:randomUUID()});
test('registration, unique username, hashed passwords, revocable sessions and server-side roles',async()=>{
 const f=await fixture();try{
 const a=f.client(),b=f.client();let result=await a.call('/api/register','POST',{username:'Admin',password,role:'manager'});assert.equal(result.status,201);assert.equal(result.body.user.role,'admin');const adminId=result.body.user.id;
 const hash=f.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(adminId).password_hash;assert.ok(!hash.includes(password));assert.equal((await b.call('/api/register','POST',{username:'ADMIN',password})).status,409);
 assert.equal((await b.call('/api/register','POST',{username:'viewer',password,role:'observer'})).status,201);
 assert.equal((await b.call('/api/leads','POST',lead())).status,403);assert.equal((await b.call('/api/tasks','POST',{title:'Нет'})).status,403);assert.equal((await b.call('/api/messages','POST',{kind:'team',body:'Нет',clientRequestId:randomUUID()})).status,403);assert.equal((await b.call(`/api/users/${adminId}/role`,'PATCH',{role:'observer'})).status,403);
 assert.equal((await b.call('/api/me/role','PATCH',{role:'manager'})).status,200);assert.equal((await b.call('/api/leads','POST',lead())).status,201);
 const oldCookie=b.cookie;assert.equal((await b.call('/api/logout','POST',{})).status,200);assert.equal((await fetch(f.base+'/api/me',{headers:{cookie:oldCookie}})).status,401);
 assert.equal((await b.call('/api/login','POST',{username:'viewer',password:'wrong'})).status,401);assert.equal((await b.call('/api/login','POST',{username:'VIEWER',password})).status,200);
 }finally{await f.close();}
});
test('non-test mode prohibits self promotion and protects last administrator',async()=>{
 const f=await fixture(false);try{const a=f.client(),b=f.client();const admin=await a.call('/api/register','POST',{username:'admin',password});const manager=await b.call('/api/register','POST',{username:'manager',password,role:'admin'});assert.equal(manager.body.user.role,'manager');assert.equal((await b.call('/api/me/role','PATCH',{role:'admin'})).status,403);assert.equal((await a.call(`/api/users/${admin.body.user.id}/role`,'PATCH',{role:'manager'})).status,409);}finally{await f.close();}
});
test('normalized duplicate detection, explicit confirmation and idempotency',async()=>{
 const f=await fixture();try{const a=f.client();await a.call('/api/register','POST',{username:'admin',password});const first=lead('+7 (999) 123-45-67');assert.equal((await a.call('/api/leads','POST',first)).status,201);assert.equal((await a.call('/api/leads','POST',first)).status,200);assert.equal(f.store.list().length,1);const duplicate={...lead('8 999 1234567'),name:'Другой клиент'};let result=await a.call('/api/leads','POST',duplicate);assert.equal(result.status,409);assert.equal(result.body.code,'DUPLICATE_LEAD');assert.equal(f.store.list().length,1);assert.equal((await a.call('/api/leads','POST',{...duplicate,confirmDuplicate:true})).status,201);assert.equal((await a.call('/api/leads','POST',{...duplicate,confirmDuplicate:true})).status,200);assert.equal(f.store.list().length,2);assert.equal((await a.call('/api/leads','POST',{...duplicate,name:'Подмена',confirmDuplicate:true})).status,409);const id=f.store.list()[0].id;assert.equal((await a.call(`/api/leads/${id}`,'PATCH',{status:'proposal',budget:120000,clientRequestId:randomUUID()})).status,200);assert.equal(f.store.get(id).status,'proposal');assert.equal((await a.call(`/api/leads/${id}/archive`,'PATCH',{archived:true})).status,200);assert.equal(f.store.get(id).archived,1);assert.equal((await a.call(`/api/leads/${id}/history`)).body.length,3);}finally{await f.close();}
});
test('task permissions, assignees, durable reminders and completion',async()=>{
 const f=await fixture();try{const a=f.client(),b=f.client(),c=f.client();const admin=(await a.call('/api/register','POST',{username:'admin',password})).body.user;const bob=(await b.call('/api/register','POST',{username:'bob',password})).body.user;await c.call('/api/register','POST',{username:'charlie',password});
 const task=(await a.call('/api/tasks','POST',{title:'Позвонить клиенту',assignee_id:bob.id,due_at:new Date(Date.now()+3600000).toISOString(),remind_at:new Date(Date.now()-60000).toISOString()})).body;
 assert.equal((await c.call(`/api/tasks/${task.id}`,'PATCH',{status:'done'})).status,403);assert.equal((await a.call('/api/notifications')).body.length,0);assert.equal((await b.call('/api/notifications')).body.length,1);assert.equal((await b.call('/api/notifications')).body.length,1);assert.equal((await b.call(`/api/tasks/${task.id}`,'PATCH',{status:'done'})).status,200);assert.ok((await b.call('/api/notifications')).body[0].read_at);assert.equal((await a.call('/api/tasks','POST',{title:'Неверная',assignee_id:admin.id,due_at:'2026-01-01',remind_at:'2027-01-01'})).status,400);
 }finally{await f.close();}
});
test('team direct messages are private; client bot replies enter outbox, retry, delivery status',async()=>{
 const f=await fixture();try{const a=f.client(),b=f.client(),c=f.client();const alice=(await a.call('/api/register','POST',{username:'alice',password})).body.user;const bob=(await b.call('/api/register','POST',{username:'bob',password})).body.user;await c.call('/api/register','POST',{username:'charlie',password});
 const privateMessage={kind:'team',target:bob.id,body:'Личное сообщение',clientRequestId:randomUUID()};await a.call('/api/messages','POST',privateMessage);await a.call('/api/messages','POST',privateMessage);assert.equal((await b.call(`/api/messages?kind=team&target=${alice.id}`)).body.length,1);assert.equal((await c.call(`/api/messages?kind=team&target=${bob.id}`)).body.length,0);assert.equal((await a.call('/api/messages?kind=team')).body.length,0);
 ['/start','Клиент','@client5','Вопрос'].forEach((text,i)=>acceptClientUpdate(f.store,{update_id:i+1,message:{chat:{id:5,type:'private'},from:{id:5},text}}));await flushOutbox(f.store,async()=>{},'client_bot');const payload={kind:'client_bot',target:'5',body:'Здравствуйте от менеджера',clientRequestId:randomUUID()};const sent=await a.call('/api/messages','POST',payload);assert.equal(sent.status,201);assert.equal(sent.body.delivery,'pending');await a.call('/api/messages','POST',payload);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 await assert.rejects(flushOutbox(f.store,async()=>{throw new Error('network');},'client_bot'));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);const calls=[];await flushOutbox(f.store,async(method,body)=>calls.push(body),'client_bot');assert.equal(calls.length,1);assert.equal((await a.call('/api/messages?kind=client_bot&target=5')).body.find(m=>m.id===sent.body.id).delivery,'sent');
 }finally{await f.close();}
});
test('bot saves repeat requests with a possible-duplicate tag and keeps follow-up chat out of new leads',()=>{
 const s=openStore();try{let i=0;const update=text=>acceptClientUpdate(s,{update_id:++i,message:{chat:{id:9,type:'private'},from:{id:9},text}});
 ['/start','Анна','@anna','Реклама'].forEach(update);assert.equal(s.list().length,1);assert.deepEqual(s.list()[0].tags,['telegram']);update('Уточнение по рекламе');assert.equal(s.list().length,1);assert.equal(s.conversations('client_bot').length,1);
 ['/new','Анна','@anna','Другой запрос'].forEach(update);assert.equal(s.list().length,2);const repeat=s.list()[0];assert.deepEqual(repeat.tags,['telegram','возможный дубль']);assert.match(s.history(repeat.id)[0].body,/Возможный дубль: Анна/);
 assert.doesNotMatch(s.db.prepare('SELECT text FROM outbox ORDER BY id DESC LIMIT 1').get().text,/дубл/);
 acceptClientUpdate(s,{update_id:i,message:{chat:{id:9,type:'private'},from:{id:9},text:'Да'}});assert.equal(s.list().length,2);
 }finally{s.close();}
});
test('accounts, sessions, tasks, messages and reminders persist across reopening database',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jumpads-v2-'));const path=join(dir,'crm.sqlite');let s=openStore(path);
 try{const user=await s.register({username:'admin',password},true);const token=s.session(user);s.saveTask({title:'Сохранённая задача',due_at:'2026-10-01T12:00:00Z',remind_at:'2026-10-01T11:00:00Z'},user);s.addMessage({kind:'team',sender_id:user.id,author:user.username,body:'История чата'});s.tick('2026-10-01T11:30:00Z');s.close();s=openStore(path);assert.equal(s.authenticate(token).username,'admin');assert.equal(s.tasks().length,1);assert.equal(s.notifications(user.id).length,1);s.tick('2026-10-01T11:35:00Z');assert.equal(s.notifications(user.id).length,1);assert.equal(s.messages(user,'team',null).length,1);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('v1 migration preserves existing leads and adds CRM fields without reset',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const dir=mkdtempSync(join(tmpdir(),'jumpads-migration-')),file=join(dir,'old.sqlite');const legacy=new DatabaseSync(file);
 legacy.exec("CREATE TABLE leads (id TEXT PRIMARY KEY,name TEXT NOT NULL,contact TEXT NOT NULL,request TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,tags TEXT NOT NULL,created_at TEXT NOT NULL)");
 legacy.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?)').run('legacy-lead','Анна','@anna','Старый запрос','manual','new','["старый"]','2026-09-01T00:00:00Z');legacy.close();
 const s=openStore(file);try{assert.equal(s.list().length,1);assert.equal(s.get('legacy-lead').name,'Анна');assert.deepEqual(s.get('legacy-lead').tags,['старый']);assert.equal(s.get('legacy-lead').archived,0);s.update('legacy-lead',{company:'Компания',budget:50000});assert.equal(s.get('legacy-lead').budget,50000);assert.equal(s.create(lead('@new')).source,'manual');}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('chat messages keep insertion order when timestamps are equal',()=>{
 const s=openStore();try{for(const body of ['Первое','Второе','Третье'])s.addMessage({kind:'team',author:'tester',body});s.db.prepare('UPDATE messages SET created_at=?').run('2026-10-01T00:00:00Z');assert.deepEqual(s.messages({id:'reader'},'team',null).map(m=>m.body),['Первое','Второе','Третье']);}finally{s.close();}
});
test('behind a trusted proxy the public host passes the origin check and login limits are per client',async()=>{
 const start=async trustProxy=>{const store=openStore(),server=createApp({store,trustProxy});server.listen(0,'127.0.0.1');await once(server,'listening');return {base:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}};};
 const login=(base,headers)=>fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({username:'nobody',password})}).then(r=>r.status);
 const viaTunnel=ip=>({origin:'https://abc.lhr.life','x-forwarded-host':'abc.lhr.life','x-forwarded-for':ip});
 const direct=await start(false);try{assert.equal(await login(direct.base,viaTunnel('1.1.1.1')),403);assert.equal(await login(direct.base,{origin:'null'}),403);}finally{await direct.close();}
 const proxied=await start(true);try{
  for(let i=0;i<15;i++)assert.equal(await login(proxied.base,viaTunnel('1.1.1.1')),401);
  assert.equal(await login(proxied.base,viaTunnel('1.1.1.1')),429);assert.equal(await login(proxied.base,viaTunnel('2.2.2.2')),401);
  assert.equal(await login(proxied.base,{...viaTunnel('3.3.3.3'),origin:'https://evil.example'}),403);
 }finally{await proxied.close();}
});
