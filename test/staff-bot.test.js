import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../src/store.js';
import { acceptUpdate } from '../src/bot.js';
import { acceptClientUpdate } from '../src/client-bot.js';
import { createApp } from '../src/server.js';

const password='Test-password-2026';
let seq=0;
const say=(s,from,text)=>acceptUpdate(s,{update_id:++seq,message:{chat:{id:from.id,type:'private'},from,text}},{clientBot:{username:'clients_bot'}});
const press=(s,from,data)=>acceptUpdate(s,{update_id:++seq,callback_query:{id:String(seq),from,message:{chat:{id:from.id,type:'private'}},data}});
const client=(s,id,text)=>acceptClientUpdate(s,{update_id:++seq,message:{chat:{id,type:'private'},from:{id,first_name:'Клиент'},text}});
const inbox=(s,chat)=>s.db.prepare("SELECT text,markup FROM outbox WHERE kind='telegram' AND chat_id=? ORDER BY id").all(String(chat)).map(r=>({text:r.text,markup:r.markup?JSON.parse(r.markup):null}));
const last=(s,chat)=>inbox(s,chat).at(-1);
const buttons=message=>(message?.markup?.inline_keyboard??[]).flat();

test('registration requires Telegram; profile changes it; a one-time link binds an account without a username',async()=>{
 const store=openStore(),server=createApp({store,testRoles:true,botStatus:{state:'connected',username:'team_bot'}});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,method='GET',data,cookie='')=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',cookie},body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 try{
  assert.equal((await call('/api/register','POST',{username:'anna',password})).status,400);
  assert.equal((await call('/api/register','POST',{username:'anna',password,telegram:'@a'})).status,400);
  const anna=await call('/api/register','POST',{username:'anna',password,telegram:'https://t.me/Anna_Petrova'});assert.equal(anna.status,201);assert.equal(anna.body.user.telegram,'anna_petrova');assert.equal(anna.body.user.telegram_linked,false);
  assert.equal((await call('/api/register','POST',{username:'boris',password,telegram:'@ANNA_petrova'})).status,409);
  const boris=await call('/api/register','POST',{username:'boris',password,telegram:'@boris_k'});
  say(store,{id:501,username:'Boris_K'},'/start');assert.equal(store.user(boris.body.user.id).telegram_linked,true);assert.match(inbox(store,501)[0].text,/привязан/);
  // A new username must be confirmed again from that Telegram account.
  const changed=await call('/api/me/telegram','PATCH',{telegram:'@boris_new'},boris.cookie);assert.equal(changed.body.user.telegram,'boris_new');assert.equal(changed.body.user.telegram_linked,false);
  const link=await call('/api/me/telegram-link','POST',{},anna.cookie);assert.equal(link.status,201);assert.match(link.body.url,/^https:\/\/t\.me\/team_bot\?start=staff_/);
  const payload=new URL(link.body.url).searchParams.get('start');
  say(store,{id:777},`/start ${payload}`);assert.equal(store.user(anna.body.user.id).telegram_linked,true);assert.match(inbox(store,777)[0].text,/привязан/);
  say(store,{id:778},`/start ${payload}`);assert.match(last(store,778).text,/недействительна/);
  assert.equal((await call('/api/users','GET',undefined,anna.cookie)).body.find(u=>u.username==='anna').telegram,'anna_petrova');
  assert.equal((await call('/api/config')).body.bots.team,'team_bot');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
});

test('team bot: strangers are sent to the client bot; staff browse leads by stage, tag and search; observers only read',async()=>{
 const s=openStore();try{
  await s.register({username:'olga',password,telegram:'@olga_admin'},true);await s.register({username:'kate',password,telegram:'@kate_view',role:'observer'},true);
  const olga={id:600,username:'olga_admin'},kate={id:601,username:'kate_view'};
  say(s,{id:700,username:'random_person'},'/start');assert.match(last(s,700).text,/@clients_bot/);
  say(s,olga,'/start');assert.match(last(s,600).text,/Здравствуйте, @olga/);
  const a=s.create({name:'Алексей',contact:'+7 900 111-22-33',request:'Лендинг',tags:['лендинг','vip']}),b=s.create({name:'Борис',contact:'@boris',request:'SEO',tags:['seo'],status:'working'});
  say(s,olga,'📋 Лиды');let message=last(s,600);assert.match(message.text,/Активные лиды: 2/);assert.ok(buttons(message).some(x=>x.callback_data===`ld:${a.id}`));
  press(s,olga,'ls:working');assert.deepEqual(buttons(last(s,600)).filter(x=>x.callback_data.startsWith('ld:')).map(x=>x.callback_data),[`ld:${b.id}`]);
  say(s,olga,'🏷 По тегу');press(s,olga,buttons(last(s,600)).find(x=>x.text.startsWith('vip')).callback_data);assert.deepEqual(buttons(last(s,600)).filter(x=>x.callback_data.startsWith('ld:')).map(x=>x.callback_data),[`ld:${a.id}`]);
  say(s,olga,'8 900 111 22 33');assert.ok(buttons(last(s,600)).some(x=>x.callback_data===`ld:${a.id}`));
  press(s,olga,`ld:${a.id}`);message=last(s,600);assert.match(message.text,/Алексей[\s\S]*Лендинг[\s\S]*Этап: Новый/);assert.ok(buttons(message).some(x=>x.callback_data===`st:${a.id}`));
  say(s,kate,'/start');press(s,kate,`ld:${a.id}`);assert.equal(buttons(last(s,601)).length,0);
  press(s,kate,`ss:${a.id}:working`);assert.match(last(s,601).text,/наблюдателя/);assert.equal(s.get(a.id).status,'new');
 }finally{s.close();}
});

test('team bot edits leads: stage, tags, owner, new lead with duplicate confirmation',async()=>{
 const s=openStore();try{
  const ivan=await s.register({username:'ivan',password,telegram:'@ivan_sales'},true),tg={id:610,username:'ivan_sales'};say(s,tg,'/start');
  const lead=s.create({name:'Мария',contact:'@maria',request:'SMM',tags:['smm']});
  press(s,tg,`ss:${lead.id}:proposal`);assert.equal(s.get(lead.id).status,'proposal');assert.match(s.history(lead.id)[0].body,/Предложение/);
  press(s,tg,`ss:${lead.id}:paid`);assert.match(last(s,610).text,/банка/);assert.equal(s.get(lead.id).status,'proposal');
  press(s,tg,`at:${lead.id}`);say(s,tg,'VIP, срочно');assert.deepEqual(s.get(lead.id).tags,['smm','vip','срочно']);
  press(s,tg,`tm:${lead.id}`);press(s,tg,buttons(last(s,610)).find(x=>x.text==='✕ smm').callback_data);assert.deepEqual(s.get(lead.id).tags,['vip','срочно']);
  press(s,tg,`me:${lead.id}`);assert.equal(s.get(lead.id).owner_id,ivan.id);
  for(const text of ['➕ Новый лид','Пётр','@petr','Сайт','сайт, новый'])say(s,tg,text);
  const created=s.list().find(l=>l.name==='Пётр');assert.deepEqual(created.tags,['сайт','новый']);assert.equal(created.owner_id,ivan.id);assert.equal(created.source,'manual');
  for(const text of ['➕ Новый лид','Пётр','@petr','Другое','-'])say(s,tg,text);assert.match(last(s,610).text,/Похожий лид/);assert.equal(s.list().filter(l=>l.name==='Пётр').length,1);
  press(s,tg,'nl:yes');assert.equal(s.list().filter(l=>l.name==='Пётр').length,2);
  assert.ok(!inbox(s,610).some(m=>m.text.startsWith('🙋')),'own assignments are not announced to their author');
 }finally{s.close();}
});

test('client requests arrive through the client bot and notify the whole team; client messages reach the owner; staff reply from Telegram',async()=>{
 const s=openStore();try{
  await s.register({username:'olga',password,telegram:'@olga_admin'},true);await s.register({username:'ivan',password,telegram:'@ivan_sales'},true);await s.register({username:'nobody',password},true);
  const olga={id:600,username:'olga_admin'},ivan={id:610,username:'ivan_sales'};say(s,olga,'/start');say(s,ivan,'/start');
  for(const text of ['/start','Анна','@anna','Нужен лендинг'])client(s,900,text);
  const lead=s.list()[0];assert.deepEqual(lead.tags,['telegram']);assert.equal(lead.client_chat_id,'900');
  for(const chat of [600,610]){const notice=last(s,chat);assert.match(notice.text,/Новое обращение[\s\S]*Анна[\s\S]*Нужен лендинг/);assert.ok(buttons(notice).some(x=>x.callback_data===`ld:${lead.id}`));}
  client(s,900,'Когда созвонимся?');assert.match(last(s,600).text,/Когда созвонимся/);assert.match(last(s,610).text,/Когда созвонимся/);
  press(s,ivan,`me:${lead.id}`);client(s,900,'Жду звонка');assert.match(last(s,610).text,/Жду звонка/);assert.doesNotMatch(last(s,600).text,/Жду звонка/);
  press(s,ivan,`rp:${lead.id}`);say(s,ivan,'Позвоню в 15:00');
  const reply=s.db.prepare("SELECT * FROM messages WHERE kind='client_bot' AND author='ivan'").get();assert.equal(reply.body,'Позвоню в 15:00');assert.equal(reply.chat_id,'900');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='client_bot' AND message_id=?").get(reply.id).n,1);
 }finally{s.close();}
});

test('every CRM notification reaches staff in Telegram: lead and task assignment, reminders, team chat and direct messages',async()=>{
 const s=openStore();try{
  const olga=await s.register({username:'olga',password,telegram:'@olga_admin'},true),ivan=await s.register({username:'ivan',password,telegram:'@ivan_sales'},true);
  const tg={id:610,username:'ivan_sales'};say(s,{id:600,username:'olga_admin'},'/start');say(s,tg,'/start');
  const lead=s.create({name:'Мария',contact:'@maria',request:'SMM'});
  s.update(lead.id,{owner_id:ivan.id},olga.id);assert.match(last(s,610).text,/Вам назначен лид: Мария/);
  const task=s.saveTask({title:'Позвонить Марии',assignee_id:ivan.id,lead_id:lead.id,due_at:new Date(Date.now()+3600000).toISOString(),remind_at:new Date(Date.now()-1000).toISOString()},olga);
  const notice=last(s,610);assert.match(notice.text,/Новая задача от @olga[\s\S]*Позвонить Марии[\s\S]*Мария/);assert.ok(buttons(notice).some(x=>x.callback_data===`td:${task.id}`));
  s.tick();s.tick();assert.equal(inbox(s,610).filter(m=>m.text.startsWith('⏰')).length,1);
  s.saveTask({title:'Своя задача'},ivan);assert.ok(!inbox(s,610).some(m=>m.text.includes('Своя задача')));
  s.addMessage({kind:'team',sender_id:olga.id,author:'olga',body:'Планёрка в 10'});assert.match(last(s,610).text,/Чат команды · olga[\s\S]*Планёрка/);assert.ok(!inbox(s,600).some(m=>m.text.includes('Планёрка')));
  s.addMessage({kind:'team',sender_id:ivan.id,recipient_id:olga.id,author:'ivan',body:'Лично'});assert.match(last(s,600).text,/Личное сообщение · ivan[\s\S]*Лично/);
  press(s,tg,`td:${task.id}`);assert.equal(s.task(task.id).status,'done');
  say(s,tg,'✅ Мои задачи');assert.match(last(s,610).text,/Ваши задачи: 1[\s\S]*Своя задача/);
 }finally{s.close();}
});
