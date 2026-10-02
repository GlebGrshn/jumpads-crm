import { setTimeout as delay } from 'node:timers/promises';
import { handleStaffUpdate } from './staff-bot.js';
// The main bot belongs to the team (see staff-bot.js); customer requests come through the client bot (client-bot.js).
export function acceptUpdate(store,update,context={}){
 const db=store.db;if(!Number.isSafeInteger(update.update_id))throw new Error('Invalid update');
 store.transaction(()=>{
  const offset=Number(db.prepare("SELECT value FROM meta WHERE key='offset'").get()?.value??0);if(update.update_id<offset)return;
  handleStaffUpdate(store,update,context);
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('offset',?)").run(String(update.update_id+1));
 });
}
export async function flushOutbox(store,call,kind='telegram'){
 const blocked=new Set();
 for(const item of store.db.prepare('SELECT * FROM outbox WHERE kind=? ORDER BY id LIMIT 100').all(kind)){
  if(blocked.has(item.chat_id))continue;
  if(kind==='client_bot'){
   const key=store.db.prepare('SELECT client_key FROM messages WHERE id=?').get(item.message_id)?.client_key??'';
   const member=store.db.prepare('SELECT * FROM client_members WHERE chat_id=?').get(item.chat_id);
   const automatic=/^(campaign:|invoice:|invoice-resend:|payment:|payment-reminder:|stage:|automation:)/.test(key);
   if(automatic&&(!member||member.blocked||!member.notifications_enabled||(key.startsWith('campaign:')&&!member.broadcast_enabled))){
    store.db.prepare("UPDATE messages SET delivery='canceled' WHERE id=?").run(item.message_id);store.db.prepare('DELETE FROM outbox WHERE id=?').run(item.id);continue;
   }
   if(key.startsWith('payment-reminder:')){
    const payment=store.db.prepare('SELECT status FROM payments WHERE id=?').get(key.slice('payment-reminder:'.length));
    if(!payment||!['NEW','FORM_SHOWED'].includes(payment.status)){store.db.prepare("UPDATE messages SET delivery='canceled' WHERE id=?").run(item.message_id);store.db.prepare('DELETE FROM outbox WHERE id=?').run(item.id);continue;}
   }
  }
  try{await call('sendMessage',{chat_id:item.chat_id,text:item.text,...(item.markup?{reply_markup:JSON.parse(item.markup)}:{})});}
  catch(e){
   if(e.code===403||e.code===400){store.db.prepare("UPDATE messages SET delivery='failed' WHERE id IN (SELECT message_id FROM outbox WHERE chat_id=? AND kind=?)").run(item.chat_id,kind);store.db.prepare('DELETE FROM outbox WHERE chat_id=? AND kind=?').run(item.chat_id,kind);if(kind==='client_bot'&&e.code===403)store.db.prepare('UPDATE client_members SET blocked=1 WHERE chat_id=?').run(item.chat_id);blocked.add(item.chat_id);continue;}throw e;
  }
  if(item.message_id)store.db.prepare("UPDATE messages SET delivery='sent' WHERE id=?").run(item.message_id);
  store.db.prepare('DELETE FROM outbox WHERE id=?').run(item.id);
 }
}
export function startBot(store,token,status,{kind='telegram',offsetKey='offset',accept=acceptUpdate,context={},allowedUpdates=['message','callback_query']}={}){
 const controller=new AbortController();
 const call=async(method,body={})=>{
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(40000)])});
  const data=await response.json();if(!data.ok){const e=new Error('Telegram API error');e.code=data.error_code;e.retryAfter=data.parameters?.retry_after;throw e;}if(method==='sendMessage')await delay(60,undefined,{signal:controller.signal});return data.result;
 };
 const done=(async()=>{let ready=false;while(!controller.signal.aborted){try{
  if(!ready){const me=await call('getMe'),webhook=await call('getWebhookInfo');if(webhook.url){const e=new Error('Webhook exists');e.code=409;throw e;}status.username=me.username;ready=true;}
  await flushOutbox(store,call,kind);
  const offset=Number(store.db.prepare('SELECT value FROM meta WHERE key=?').get(offsetKey)?.value??0);
  const updates=await call('getUpdates',{offset,timeout:5,allowed_updates:allowedUpdates});
  for(const update of updates){
   accept(store,update,context);
   // A pressed button keeps spinning in Telegram until it is answered; a lost answer is harmless.
   if(update.callback_query)await call('answerCallbackQuery',{callback_query_id:update.callback_query.id}).catch(()=>{});
  }
  await flushOutbox(store,call,kind);status.state='connected';status.lastSync=new Date().toISOString();
 }catch(e){if(controller.signal.aborted)break;status.state=e.code===409?'conflict':e.code===401?'invalid_token':'retrying';await delay(Math.max(5000,Number(e.retryAfter||0)*1000),undefined,{signal:controller.signal}).catch(()=>{});}}})();
 return async()=>{controller.abort();await done;};
}
