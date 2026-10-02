import { randomUUID } from 'node:crypto';
import { fail } from './crm.js';
import { notifyClient, notifyStage } from './client-bot.js';

export const triggers=['lead.created','lead.updated','lead.stage','task.created','task.done','payment.confirmed','client.joined','manual'];
const stages=['new','working','proposal','won','paid','closed'];
const fields=['status','source','owner_id','budget','paid','tags','name','company'];
export function initAutomations(store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS automation_context(id INTEGER PRIMARY KEY,active INTEGER NOT NULL);
 INSERT OR IGNORE INTO automation_context VALUES(1,0);
 CREATE TABLE IF NOT EXISTS automation_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,definition TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS automation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,lead_id TEXT,entity_id TEXT,stage TEXT,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),processed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,event_key TEXT NOT NULL,lead_id TEXT,definition TEXT NOT NULL,owner_id TEXT NOT NULL,state TEXT NOT NULL,step INTEGER NOT NULL DEFAULT 0,wake_at TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,UNIQUE(rule_id,event_key));
 CREATE TABLE IF NOT EXISTS automation_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,step INTEGER NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS kanban_views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,filters TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS automation_events_pending ON automation_events(processed,id);
 CREATE INDEX IF NOT EXISTS automation_runs_due ON automation_runs(state,wake_at);`);
 const definitions=[
  ['lead_create','AFTER INSERT ON leads','lead.created','NEW.id','NEW.id','NEW.status','1'],
  ['lead_update','AFTER UPDATE OF name,contact,request,company,budget,owner_id,tags,notes ON leads','lead.updated','NEW.id','NEW.id','NEW.status',"NEW.name IS NOT OLD.name OR NEW.contact IS NOT OLD.contact OR NEW.request IS NOT OLD.request OR NEW.company IS NOT OLD.company OR NEW.budget IS NOT OLD.budget OR NEW.owner_id IS NOT OLD.owner_id OR NEW.tags IS NOT OLD.tags OR NEW.notes IS NOT OLD.notes"],
  ['lead_stage','AFTER UPDATE OF status ON leads','lead.stage','NEW.id','NEW.id','NEW.status','NEW.status IS NOT OLD.status'],
  ['task_create','AFTER INSERT ON tasks','task.created','NEW.lead_id','NEW.id','NULL','1'],
  ['task_done','AFTER UPDATE OF status ON tasks','task.done','NEW.lead_id','NEW.id','NULL',"NEW.status='done' AND OLD.status!='done'"],
  ['payment_confirm','AFTER UPDATE OF status ON payments','payment.confirmed','NEW.lead_id','NEW.id','NULL',"NEW.status='CONFIRMED' AND OLD.status!='CONFIRMED'"],
  ['client_join','AFTER INSERT ON client_members','client.joined','NEW.lead_id','NEW.chat_id','NULL','1']
 ];
 for(const [name,on,kind,lead,entity,stage,condition] of definitions)db.exec(`CREATE TRIGGER IF NOT EXISTS auto_${name} ${on} WHEN (SELECT active FROM automation_context WHERE id=1)=0 AND (${condition}) BEGIN INSERT INTO automation_events(kind,lead_id,entity_id,stage) VALUES('${kind}',${lead},${entity},${stage}); END;`);
}

export function createAutomationService(store){
 initAutomations(store);const db=store.db;
 const decode=r=>r&&({...r,enabled:!!r.enabled,...JSON.parse(r.definition)});
 function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Нужен сценарий');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120)throw fail(400,'Укажите название до 120 символов');
  if(typeof input.enabled!=='boolean'||!triggers.includes(input.trigger)||!['all','any'].includes(input.mode))throw fail(400,'Некорректное событие или режим условий');
  if(!Array.isArray(input.conditions)||input.conditions.length>12||!Array.isArray(input.actions)||!input.actions.length||input.actions.length>20)throw fail(400,'Нужно 1–20 действий и не более 12 условий');
  const conditions=input.conditions.map(c=>{
   if(!c||!fields.includes(c.field)||!['eq','ne','contains','gte','lte'].includes(c.op)||!['string','number'].includes(typeof c.value)||String(c.value).length>200)throw fail(400,'Некорректное условие');
   if(['gte','lte'].includes(c.op)&&(c.field!=='budget'||!Number.isFinite(Number(c.value))))throw fail(400,'Сравнение чисел доступно для суммы');
   if(c.field==='paid'&&!['0','1'].includes(String(c.value)))throw fail(400,'Оплата: 0 или 1');
   return {field:c.field,op:c.op,value:c.value};
  });
  const actions=input.actions.map(a=>{
   if(!a||!['stage','tag','owner','task','team','client','wait','check'].includes(a.type))throw fail(400,'Неизвестное действие');
   const value=String(a.value??'').trim(),minutes=Number(a.minutes??60),assignee=String(a.assignee??'owner');
   if(a.type==='wait'||a.type==='task'){if(!Number.isInteger(minutes)||minutes<1||minutes>43200)throw fail(400,'Время: от 1 до 43200 минут');}
   if(a.type==='stage'&&!stages.includes(value))throw fail(400,'Неизвестный этап');
   if(a.type==='owner'&&!store.user(value))throw fail(400,'Ответственный не найден');
   if(a.type==='task'&&assignee!=='owner'&&!store.user(assignee))throw fail(400,'Исполнитель не найден');
   const limit=a.type==='tag'?40:a.type==='task'?200:3500;
   if(!['wait','check'].includes(a.type)&&(!value||value.length>limit))throw fail(400,`Заполните действие (до ${limit} символов)`);
   return {type:a.type,value,minutes,assignee};
  });
  return {trigger:input.trigger,mode:input.mode,conditions,actions};
 }
 function matches(rule,lead){
  const test=c=>{const v=lead?.[c.field]??'';if(c.op==='contains')return Array.isArray(v)?v.includes(String(c.value)):String(v).toLowerCase().includes(String(c.value).toLowerCase());if(c.op==='gte')return Number(v)>=Number(c.value);if(c.op==='lte')return Number(v)<=Number(c.value);const eq=Array.isArray(v)?v.includes(String(c.value)):String(v)===String(c.value);return c.op==='eq'?eq:!eq;};
  return !rule.conditions.length||(rule.mode==='all'?rule.conditions.every(test):rule.conditions.some(test));
 }
 const list=()=>db.prepare('SELECT * FROM automation_rules ORDER BY created_at DESC').all().map(decode);
 const get=id=>decode(db.prepare('SELECT * FROM automation_rules WHERE id=?').get(id));
 function save(input,user,id=null){
  const definition=validate(input);if(id&&!get(id))throw fail(404,'Автоматизация не найдена');
  id??=randomUUID();
  store.transaction(()=>{
   // Drain past events against their existing rules before publishing a new version.
   while(db.prepare('SELECT 1 FROM automation_events WHERE processed=0 LIMIT 1').get())dispatch();
   db.prepare('INSERT INTO automation_rules VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,definition=excluded.definition,owner_id=excluded.owner_id').run(id,input.name.trim(),Number(input.enabled),JSON.stringify(definition),user.id,new Date().toISOString());
   if(!input.enabled)db.prepare("UPDATE automation_runs SET state='canceled',error='Сценарий выключен' WHERE rule_id=? AND state='waiting'").run(id);
  });return get(id);
 }
 function start(rule,leadId,eventKey,now){
  const lead=leadId?store.get(leadId):null,matched=(!lead||!lead.archived)&&matches(rule,lead);
  const id=randomUUID();db.prepare('INSERT OR IGNORE INTO automation_runs(id,rule_id,event_key,lead_id,definition,owner_id,state,wake_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,rule.id,eventKey,leadId,JSON.stringify(rule),rule.owner_id,matched?'waiting':'skipped',now,now);
  return db.prepare('SELECT * FROM automation_runs WHERE rule_id=? AND event_key=?').get(rule.id,eventKey);
 }
 // Runs started here must be due in the same tick that reads them: one clock reading for both.
 function dispatch(now=new Date().toISOString()){
  const rules=list().filter(r=>r.enabled);
  for(const e of db.prepare('SELECT * FROM automation_events WHERE processed=0 ORDER BY id LIMIT 500').all()){
   for(const rule of rules)if(rule.trigger===e.kind){
    // A stage event belongs to its recorded stage even if the lead has since moved.
    if(e.kind==='lead.stage'&&store.get(e.lead_id)?.status!==e.stage)continue;
    start(rule,e.lead_id,`event:${e.id}`,now);
   }
   db.prepare('UPDATE automation_events SET processed=1 WHERE id=?').run(e.id);
  }
 }
 const template=(text,lead)=>text.replace(/\{\{(name|contact|company|budget|status)\}\}/g,(_,key)=>String(lead?.[key]??''));
 function execute(run,now){
  const rule=JSON.parse(run.definition),actor=store.user(run.owner_id),lead=run.lead_id?store.get(run.lead_id):null;
  if(!get(run.rule_id)?.enabled||actor?.role!=='admin'||lead?.archived)throw new Error('Сценарий выключен, автор больше не администратор или лид архивирован');
  const a=rule.actions[run.step];if(!a){db.prepare("UPDATE automation_runs SET state='done' WHERE id=?").run(run.id);return;}
  const key=`automation:${run.id}:${run.step}`,value=template(a.value,lead);let detail='Выполнено';
  if(a.type==='check'&&!matches(rule,lead)){
   db.prepare('INSERT INTO automation_logs(run_id,step,detail,created_at) VALUES(?,?,?,?)').run(run.id,run.step,'Условия больше не совпадают. Цепочка остановлена.',now);
   db.prepare("UPDATE automation_runs SET step=?,state='skipped' WHERE id=?").run(run.step+1,run.id);return;
  }
  if(['stage','tag','owner','client'].includes(a.type)&&!lead)throw new Error('Для действия нужен связанный лид');
  if(a.type==='stage'){
   if(a.value==='paid'&&!lead.paid)throw new Error('Оплата ещё не подтверждена банком');
   if(lead.status!==a.value){store.update(lead.id,{status:a.value});notifyStage(store,lead.id,a.value,key);}
  }else if(a.type==='tag'){store.update(lead.id,{tags:[...new Set([...lead.tags,value.toLowerCase()])]});}
  else if(a.type==='owner'){if(!store.user(a.value))throw new Error('Ответственный не найден');store.update(lead.id,{owner_id:a.value});}
  else if(a.type==='task'){
   const due=new Date(Date.parse(now)+a.minutes*60000).toISOString();
   store.saveTask({title:value,assignee_id:a.assignee==='owner'?(lead?.owner_id||actor.id):a.assignee,lead_id:lead?.id,due_at:due,remind_at:due},actor);
  }else if(a.type==='team'){store.addMessage({kind:'team',sender_id:actor.id,author:`Робот · ${rule.name}`,body:value,client_key:key});}
  else if(a.type==='client'){if(!notifyClient(store,lead.id,value,key))throw new Error('Клиент не подключён или отключил уведомления');detail='Сообщение поставлено в очередь бота';}
  const next=run.step+1,wake=a.type==='wait'?new Date(Date.parse(now)+a.minutes*60000).toISOString():now;
  if(a.type==='wait')detail=`Пауза до ${wake}`;
  db.prepare('INSERT INTO automation_logs(run_id,step,detail,created_at) VALUES(?,?,?,?)').run(run.id,run.step,`${a.type}: ${detail}`,now);
  if(lead&&!['wait','check'].includes(a.type))store.activity(lead.id,`Робот · ${rule.name}`,`${a.type}: ${value}`);
  db.prepare('UPDATE automation_runs SET step=?,wake_at=?,state=? WHERE id=?').run(next,wake,next===rule.actions.length&&a.type!=='wait'?'done':'waiting',run.id);
 }
 function tick(now=new Date().toISOString()){
  store.transaction(()=>dispatch(now));
  // One step per run per tick gives other work a chance; each step and its side effects commit together.
  for(const run of db.prepare("SELECT * FROM automation_runs WHERE state='waiting' AND wake_at<=? ORDER BY created_at LIMIT 100").all(now)){
   try{store.transaction(()=>{db.prepare('UPDATE automation_context SET active=1 WHERE id=1').run();execute(run,now);db.prepare('UPDATE automation_context SET active=0 WHERE id=1').run();});}
   catch(e){db.prepare("UPDATE automation_runs SET state='failed',error=? WHERE id=?").run(String(e.message).slice(0,500),run.id);}
  }
 }
 return {list,get,save,tick,validate,matches,
  preview(input,leadId){const rule=validate(input),lead=store.get(leadId);if(!lead)throw fail(404,'Выберите лида');return {matches:!lead.archived&&matches(rule,lead),actions:rule.actions.map(a=>({...a,value:template(a.value,lead)}))};},
  manual(id,leadId,requestId){const rule=get(id);if(!rule||!rule.enabled||rule.trigger!=='manual')throw fail(409,'Нужен включённый сценарий с ручным запуском');if(!store.get(leadId))throw fail(404,'Лид не найден');if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw fail(400,'Нужен ключ запуска');const old=db.prepare('SELECT * FROM automation_runs WHERE rule_id=? AND event_key=?').get(id,`manual:${requestId}`);if(old&&old.lead_id!==leadId)throw fail(409,'Ключ запуска уже использован для другого лида');return start(rule,leadId,`manual:${requestId}`,new Date().toISOString());},
  runs(){return db.prepare('SELECT r.*,a.name FROM automation_runs r LEFT JOIN automation_rules a ON a.id=r.rule_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 100').all().map(r=>({...r,definition:undefined,logs:db.prepare('SELECT step,detail,created_at FROM automation_logs WHERE run_id=? ORDER BY id').all(r.id)}));},
  cancel(id){db.prepare("UPDATE automation_runs SET state='canceled',error='Остановлено пользователем' WHERE id=? AND state='waiting'").run(id);}
 };
}
