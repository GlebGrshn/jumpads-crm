import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from '../src/store.js';
import { flushOutbox } from '../src/bot.js';
import { acceptClientUpdate } from '../src/client-bot.js';
import { createApp } from '../src/server.js';
const lead={name:'Анна',contact:'@anna',request:'Нужен сайт',tags:['Реклама','реклама']};
const update=(id,text,chat=7)=>({update_id:id,message:{chat:{id:chat,type:'private'},from:{id:chat},text}});
test('manual lead, tag normalization, validation and edit',()=>{
 const s=openStore();try{const l=s.create(lead);assert.deepEqual(l.tags,['реклама']);assert.equal(l.source,'manual');assert.equal(s.update(l.id,{...lead,status:'working',tags:['VIP']}).status,'working');assert.throws(()=>s.create({...lead,name:' '}));assert.throws(()=>s.create({...lead,tags:['x'.repeat(41)]}));assert.throws(()=>s.create({...lead,status:'invalid'}));}finally{s.close();}
});
test('client bot request survives restart, creates one tagged lead and delivers retryable replies',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jumpads-test-'));const file=join(dir,'db.sqlite');let s=openStore(file);
 try{acceptClientUpdate(s,update(1,'/start'));acceptClientUpdate(s,update(2,'Анна'));s.close();s=openStore(file);acceptClientUpdate(s,update(3,'@anna'));acceptClientUpdate(s,update(4,'Нужен сайт'));acceptClientUpdate(s,update(4,'Нужен сайт'));assert.equal(s.list().length,1);assert.equal(s.list()[0].source,'telegram');assert.deepEqual(s.list()[0].tags,['telegram']);assert.equal(s.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);await assert.rejects(flushOutbox(s,async()=>{throw new Error('network');},'client_bot'));assert.equal(s.db.prepare('SELECT count(*) AS n FROM outbox').get().n,4);const replies=[];await flushOutbox(s,async(method,payload)=>replies.push(payload.text),'client_bot');assert.equal(replies.length,4);assert.match(replies[3],/передана/);s.close();s=openStore(file);assert.equal(s.list().length,1);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('bot cancellation, parallel chats and unsupported messages',()=>{
 const s=openStore();try{acceptClientUpdate(s,update(1,'/start'));acceptClientUpdate(s,update(2,'/start',8));acceptClientUpdate(s,update(3,'Анна'));acceptClientUpdate(s,update(4,'/cancel'));acceptClientUpdate(s,update(5,'Борис',8));acceptClientUpdate(s,update(6,'@boris',8));acceptClientUpdate(s,update(7,'',8));assert.equal(s.list().length,0);acceptClientUpdate(s,update(8,'Реклама',8));assert.equal(s.list()[0].name,'Борис');const group=update(9,'/start');group.message.chat.type='group';acceptClientUpdate(s,group);assert.equal(s.list().length,1);}finally{s.close();}
});
test('HTTP auth, manual create/edit/filter and Telegram to CRM integration',async()=>{
 const s=openStore(),password='test-password-123456';const server=createApp({store:s,password});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='';const request=(path,method='GET',data)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',cookie},body:data===undefined?undefined:JSON.stringify({...data,...(path.startsWith('/api/leads')?{clientRequestId:randomUUID()}:{})})});
 try{assert.equal((await request('/api/leads')).status,401);assert.equal((await request('/api/login','POST',{password:'wrong'})).status,401);const login=await request('/api/register','POST',{username:'tester',password,telegram:'@tester_tg'});assert.equal(login.status,201);cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly/);const made=await request('/api/leads','POST',lead);assert.equal(made.status,201);const l=await made.json();assert.equal((await request(`/api/leads/${l.id}`,'PATCH',{...lead,tags:['Приоритет']})).status,200);assert.equal((await(await request('/api/leads?tag='+encodeURIComponent('приоритет'))).json()).length,1);assert.equal((await(await request('/api/leads?tag=absent')).json()).length,0);for(const [i,text] of ['/start','Борис','@boris','Продвижение'].entries())acceptClientUpdate(s,update(i+1,text));const incoming=await(await request('/api/leads?tag=telegram')).json();assert.equal(incoming.length,1);assert.equal(incoming[0].name,'Борис');assert.equal((await request('/api/leads','POST',{...lead,name:''})).status,400);assert.equal((await fetch(base+'/api/leads',{method:'POST',headers:{cookie,'Content-Type':'application/json',Origin:'https://evil.invalid'},body:JSON.stringify(lead)})).status,403);assert.equal((await request('/.env')).status,404);assert.equal((await request('/')).status,200);const logout=await request('/api/logout','POST',{});cookie=logout.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/leads')).status,401);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));s.close();}
});

