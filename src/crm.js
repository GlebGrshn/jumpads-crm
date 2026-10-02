import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { initCommerceStore } from './commerce-store.js';
const scrypt=promisify(scryptCallback);
export const roles=['admin','manager','observer'];
export const permissions={admin:['leads:write','leads:archive','leads:delete','tasks:write','tasks:all','chat:write','users:roles'],manager:['leads:write','tasks:write','chat:write'],observer:[]};
export const fail=(status,message,extra={})=>Object.assign(new Error(message),{status,...extra});
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const normalizeContact=value=>{
 const text=String(value).trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?t\.me\//,'@').replace(/\/$/,'');
 if (/^[+\d\s().-]+$/.test(text)) { const digits=text.replace(/\D/g,'');return digits.length===11&&digits.startsWith('8')?'7'+digits.slice(1):digits; }
 return text;
};
const clean=(v,label,max,required=true)=>{if(typeof v!=='string'||v.trim().length>max||(required&&!v.trim()))throw fail(400,`${label}: ${required?'от 1 до':'до'} ${max} символов`);return v.trim();};
// Telegram username as staff type it: @name, name or a t.me link. Empty means "not set".
export const normalizeTelegram=value=>{
 if(value===undefined||value===null||(typeof value==='string'&&!value.trim()))return null;
 const name=typeof value==='string'?value.trim().replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i,'').replace(/^@/,'').replace(/\/$/,''):'';
 if(!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(name))throw fail(400,'Telegram: юзернейм из 5–32 латинских букв, цифр и _, например @ivan_petrov');
 return name.toLowerCase();
};
export const when=iso=>iso?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:process.env.BOT_TIMEZONE||'Europe/Moscow'}).format(new Date(iso)):'без срока';
const taskButtons=(taskId,lead)=>({inline_keyboard:[[{text:'✅ Выполнено',callback_data:`td:${taskId}`},...(lead?[{text:'Открыть лид',callback_data:`ld:${lead.id}`}]:[])]]});
export function extendStore(store) {
 const db=store.db;
 const columns=new Set(db.prepare('PRAGMA table_info(leads)').all().map(c=>c.name));
 for(const [name,type] of Object.entries({company:"TEXT NOT NULL DEFAULT ''",budget:'REAL NOT NULL DEFAULT 0',owner_id:'TEXT',notes:"TEXT NOT NULL DEFAULT ''",archived:'INTEGER NOT NULL DEFAULT 0',deleted_at:'TEXT',telegram_chat_id:'TEXT'}))if(!columns.has(name))db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
 const outboxColumns=db.prepare('PRAGMA table_info(outbox)').all();
 if(!outboxColumns.some(c=>c.name==='message_id'))db.exec('ALTER TABLE outbox ADD COLUMN message_id TEXT');
 db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,assignee_id TEXT NOT NULL,lead_id TEXT,due_at TEXT,remind_at TEXT,status TEXT NOT NULL,priority TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,task_id TEXT NOT NULL,remind_at TEXT NOT NULL,title TEXT NOT NULL,read_at TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,task_id,remind_at));
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,kind TEXT NOT NULL,sender_id TEXT,recipient_id TEXT,chat_id TEXT,author TEXT NOT NULL,body TEXT NOT NULL,delivery TEXT NOT NULL,created_at TEXT NOT NULL,client_key TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,actor TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mutations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(status,remind_at);
 CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at);`);
 // Staff Telegram: the username they declare, and the numeric id bound when they first write to the team bot.
 const userColumns=new Set(db.prepare('PRAGMA table_info(users)').all().map(c=>c.name));
 for(const name of ['telegram_username','telegram_id'])if(!userColumns.has(name))db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT`);
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_username ON users(telegram_username) WHERE telegram_username IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS staff_links(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
 const publicUser=row=>row&&({id:row.id,username:row.username,role:row.role,created_at:row.created_at,telegram:row.telegram_username??null,telegram_linked:Boolean(row.telegram_id)});
 const telegramTaken=(telegram,exceptId='')=>telegram&&db.prepare('SELECT 1 FROM users WHERE telegram_username=? AND id!=?').get(telegram,exceptId);
 initCommerceStore(store);
 Object.assign(store,{
  transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
  users:()=>db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser),
  user:id=>publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)),
  async register(input,testRoles,{requireTelegram=false}={}){
   const username=clean(input?.username??'','Юзернейм',32).toLowerCase();
   if(!/^[a-z0-9_]{3,32}$/.test(username))throw fail(400,'Юзернейм: 3–32 латинские буквы, цифры или _');
   if(typeof input.password!=='string'||input.password.length<8||input.password.length>128)throw fail(400,'Пароль: от 8 до 128 символов');
   if(input.role!==undefined&&!roles.includes(input.role))throw fail(400,'Неизвестная роль');
   const telegram=normalizeTelegram(input.telegram);
   if(requireTelegram&&!telegram)throw fail(400,'Укажите свой Telegram: через него приходят уведомления и работает бот команды');
   if(telegramTaken(telegram))throw fail(409,'Этот Telegram уже указан у другого сотрудника');
   const salt=randomBytes(16).toString('hex');const digest=await scrypt(input.password,salt,64);
   // Count after hashing: concurrent first registrations must not both become administrators.
   const role=db.prepare('SELECT count(*) AS n FROM users').get().n===0?'admin':testRoles?(input.role??'manager'):'manager';
   const id=randomUUID();
   try{db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,telegram_username) VALUES (?,?,?,?,?,?)').run(id,username,`${salt}:${digest.toString('hex')}`,role,new Date().toISOString(),telegram);}
   catch(e){if(e.code?.startsWith('ERR_SQLITE')&&store.users().some(u=>u.username===username))throw fail(409,'Этот юзернейм уже занят');if(e.code?.startsWith('ERR_SQLITE')&&telegramTaken(telegram,id))throw fail(409,'Этот Telegram уже указан у другого сотрудника');throw e;}
   return store.user(id);
  },
  setTelegram(id,value){
   const telegram=normalizeTelegram(value),row=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!row)throw fail(404,'Пользователь не найден');
   if(telegramTaken(telegram,id))throw fail(409,'Этот Telegram уже указан у другого сотрудника');
   // A new username must be confirmed again by writing to the bot from that account.
   if(telegram!==row.telegram_username)db.prepare('UPDATE users SET telegram_username=?,telegram_id=NULL WHERE id=?').run(telegram,id);
   return store.user(id);
  },
  staffLink(userId){const token=randomBytes(18).toString('base64url');db.prepare('DELETE FROM staff_links WHERE expires_at<? OR user_id=?').run(Date.now(),userId);db.prepare('INSERT INTO staff_links VALUES (?,?,?)').run(hash(token),userId,Date.now()+86400000);return token;},
  // The one-time link proves the CRM account, Telegram proves the chat: bind them even without a username.
  consumeStaffLink(token,from){
   const row=db.prepare('SELECT * FROM staff_links WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());if(!row||!store.user(row.user_id))return null;
   db.prepare('DELETE FROM staff_links WHERE token_hash=?').run(row.token_hash);store.bindTelegram(row.user_id,String(from.id));
   const username=from.username?.toLowerCase();if(username&&!telegramTaken(username,row.user_id))db.prepare('UPDATE users SET telegram_username=? WHERE id=?').run(username,row.user_id);
   return store.user(row.user_id);
  },
  bindTelegram(userId,telegramId){db.prepare('UPDATE users SET telegram_id=NULL WHERE telegram_id=? AND id!=?').run(telegramId,userId);db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(telegramId,userId);},
  // Telegram verifies the sender, so a username declared in the CRM profile is bound on first contact.
  staffByTelegram(from){
   const id=String(from.id);let row=db.prepare('SELECT * FROM users WHERE telegram_id=?').get(id);
   if(!row&&from.username){row=db.prepare('SELECT * FROM users WHERE telegram_username=? AND telegram_id IS NULL').get(from.username.toLowerCase());if(row)store.bindTelegram(row.id,id);}
   return row?store.user(row.id):null;
  },
  // Team bot messages are not customer conversations: they go straight to the outbox without a messages row.
  queueStaff(chat,text,markup=null){db.prepare('INSERT INTO outbox(chat_id,text,message_id,kind,markup) VALUES (?,?,NULL,?,?)').run(String(chat),text.slice(0,4000),'telegram',markup?JSON.stringify(markup):null);},
  notifyUsers(ids,text,markup=null){for(const id of new Set(ids.filter(Boolean))){const row=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(id);if(row?.telegram_id)store.queueStaff(row.telegram_id,text,markup);}},
  notifyTeam(text,markup=null,exceptId=null){for(const row of db.prepare('SELECT id,telegram_id FROM users WHERE telegram_id IS NOT NULL').all())if(row.id!==exceptId)store.queueStaff(row.telegram_id,text,markup);},
  async login(input){
   const username=typeof input?.username==='string'?input.username.trim().toLowerCase():'';
   const password=typeof input?.password==='string'&&input.password.length<=128?input.password:'';
   const row=db.prepare('SELECT * FROM users WHERE username=?').get(username);
   const [salt,digest]=(row?.password_hash??`${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
   const candidate=await scrypt(password,salt,64);
   if(!row||!timingSafeEqual(candidate,Buffer.from(digest,'hex')))throw fail(401,'Неверный юзернейм или пароль');
   return publicUser(row);
  },
  session(user){const token=randomBytes(32).toString('base64url');db.prepare('DELETE FROM auth_sessions WHERE expires_at<?').run(Date.now());db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(hash(token),user.id,Date.now()+43200000);return token;},
  authenticate(token){return publicUser(db.prepare('SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token),Date.now()));},
  logout(token){db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));},
  setRole(id,role){if(!roles.includes(role))throw fail(400,'Неизвестная роль');if(!store.user(id))throw fail(404,'Пользователь не найден');db.prepare('UPDATE users SET role=? WHERE id=?').run(role,id);return store.user(id);},
  duplicates(input,exclude=null){const contact=normalizeContact(input.contact),name=input.name.trim().toLowerCase(),request=input.request.trim().toLowerCase();return store.list().filter(l=>l.id!==exclude&&(normalizeContact(l.contact)===contact||(l.name.toLowerCase()===name&&l.request.toLowerCase()===request)));},
  activity(id,actor,body){db.prepare('INSERT INTO activity VALUES (?,?,?,?,?)').run(randomUUID(),id,actor,body,new Date().toISOString());},
  history:id=>db.prepare('SELECT * FROM activity WHERE lead_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(id),
  tasks:()=>db.prepare('SELECT * FROM tasks ORDER BY CASE WHEN status=\'done\' THEN 1 ELSE 0 END,due_at IS NULL,due_at,created_at DESC').all(),
  task:id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id),
  saveTask(input,user,id=null){
   const old=id?store.task(id):null;if(id&&!old)throw fail(404,'Задача не найдена');
   if(old&&user.role!=='admin'&&old.created_by!==user.id&&old.assignee_id!==user.id)throw fail(403,'Изменять задачу может её автор, исполнитель или администратор');
   const v={...old,...input};const title=clean(v.title??'','Название',200),description=clean(v.description??'','Описание',4000,false);
   const assignee=v.assignee_id||user.id;if(!store.user(assignee))throw fail(400,'Исполнитель не найден');
   if(v.lead_id&&!store.get(v.lead_id))throw fail(400,'Лид не найден');
   const date=(value,label)=>{if(!value)return null;if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw fail(400,`Некорректное ${label}`);return new Date(value).toISOString();};
   const due=date(v.due_at,'время срока'),remind=date(v.remind_at,'время напоминания');
   if(remind&&!due)throw fail(400,'Для напоминания укажите срок');if(remind&&remind>due)throw fail(400,'Напоминание должно быть не позже срока');
   const status=v.status??'todo',priority=v.priority??'normal';
   if(!['todo','doing','done'].includes(status)||!['low','normal','high'].includes(priority))throw fail(400,'Неверный статус или приоритет задачи');
   const taskId=id??randomUUID();
   if(old)db.prepare('UPDATE tasks SET title=?,description=?,assignee_id=?,lead_id=?,due_at=?,remind_at=?,status=?,priority=? WHERE id=?').run(title,description,assignee,v.lead_id||null,due,remind,status,priority,taskId);
   else db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(taskId,title,description,assignee,v.lead_id||null,due,remind,status,priority,user.id,new Date().toISOString());
   if(old&&(old.remind_at!==remind||old.assignee_id!==assignee||status==='done'))db.prepare('UPDATE notifications SET read_at=? WHERE task_id=? AND read_at IS NULL').run(new Date().toISOString(),taskId);
   if((!old||old.assignee_id!==assignee)&&assignee!==user.id&&status!=='done'){
    const lead=v.lead_id?store.get(v.lead_id):null;
    store.notifyUsers([assignee],`📌 ${old?'Вам передана задача':'Новая задача'} от @${user.username}\n${title}${due?`\nСрок: ${when(due)}`:''}${lead?`\nЛид: ${lead.name}`:''}`,taskButtons(taskId,lead));
   }
   return store.task(taskId);
  },
  tick(now=new Date().toISOString()){
   for(const task of db.prepare("SELECT * FROM tasks WHERE status!='done' AND remind_at IS NOT NULL AND remind_at<=?").all(now)){
    // INSERT OR IGNORE makes the reminder once-only; Telegram follows only a reminder that was actually created.
    if(!db.prepare('INSERT OR IGNORE INTO notifications VALUES (?,?,?,?,?,NULL,?)').run(randomUUID(),task.assignee_id,task.id,task.remind_at,`Задача: ${task.title}`,now).changes)continue;
    const lead=task.lead_id?store.get(task.lead_id):null;
    store.notifyUsers([task.assignee_id],`⏰ Напоминание: ${task.title}${task.due_at?`\nСрок: ${when(task.due_at)}`:''}${lead?`\nЛид: ${lead.name}`:''}`,taskButtons(task.id,lead));
   }
  },
  notifications:userId=>db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(userId),
  addMessage({kind,sender_id=null,recipient_id=null,chat_id=null,author,body,delivery='sent',client_key=null}){
   body=clean(body,'Сообщение',4000);
   if(client_key){const old=db.prepare('SELECT * FROM messages WHERE client_key=?').get(client_key);if(old){if(old.kind!==kind||old.body!==body||old.chat_id!==chat_id||old.recipient_id!==recipient_id)throw fail(409,'Ключ сообщения уже использован');return old;}}
   const id=randomUUID();db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,kind,sender_id,recipient_id,chat_id,author,body,delivery,new Date().toISOString(),client_key);
   if(kind==='team'){
    const notice=`💬 ${recipient_id?'Личное сообщение':'Чат команды'} · ${author}\n${body.slice(0,1500)}`;
    // Robot messages are news for their author too; people do not need their own message echoed.
    if(recipient_id)store.notifyUsers([recipient_id],notice);else store.notifyTeam(notice,null,author.startsWith('Робот')?null:sender_id);
   }
   return db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  },
  queueReply(chat,body,author='Бот',sender=null,key=null,kind='telegram',markup=null){
   const m=store.addMessage({kind,chat_id:chat,body,author,sender_id:sender,delivery:'pending',client_key:key});
   if(!db.prepare('SELECT id FROM outbox WHERE message_id=?').get(m.id)&&m.delivery==='pending')db.prepare('INSERT INTO outbox(chat_id,text,message_id,kind,markup) VALUES (?,?,?,?,?)').run(chat,body,m.id,kind,markup?JSON.stringify(markup):null);
   return m;
  },
  conversations(kind='telegram'){return db.prepare('SELECT chat_id,max(created_at) AS updated_at FROM messages WHERE kind=? GROUP BY chat_id ORDER BY updated_at DESC').all(kind).map(c=>({...c,lead:store.list().find(l=>l[kind==='client_bot'?'client_chat_id':'telegram_chat_id']===c.chat_id)??null,last:db.prepare('SELECT * FROM messages WHERE kind=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(kind,c.chat_id)}));},
  messages(user,kind,target){
   if(['telegram','client_bot'].includes(kind))return db.prepare('SELECT * FROM messages WHERE kind=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(kind,target).reverse();
   if(target){if(!store.user(target))throw fail(404,'Собеседник не найден');return db.prepare("SELECT * FROM messages WHERE kind='team' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)) ORDER BY created_at DESC,rowid DESC LIMIT 200").all(user.id,target,target,user.id).reverse();}
   return db.prepare("SELECT * FROM messages WHERE kind='team' AND recipient_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 200").all().reverse();
  }
 });
 return store;
}
