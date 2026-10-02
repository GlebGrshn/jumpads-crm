// Team bot: the main CRM features for staff in Telegram. Staff are recognised by the Telegram account bound to their
// CRM profile; everyone else is sent to the client bot. All replies go through the outbox like any bot message.
import { createHash } from 'node:crypto';
import { permissions, fail, when, normalizeContact } from './crm.js';
import { validateLead } from './store.js';
import { notifyStage } from './client-bot.js';

const stages={new:'Новый',working:'В работе',proposal:'Предложение',won:'Сделка',paid:'Оплачено',closed:'Закрыт'};
const roleNames={admin:'Администратор',manager:'Менеджер',observer:'Наблюдатель'};
const sources={manual:'Вручную',telegram:'Telegram-бот',client_bot:'Клиентский бот'};
const MENU={keyboard:[[{text:'📋 Лиды'},{text:'🏷 По тегу'}],[{text:'➕ Новый лид'},{text:'✅ Мои задачи'}],[{text:'ℹ️ Помощь'}]],resize_keyboard:true,is_persistent:true};
// Callback data is limited to 64 bytes: tags (up to 40 Cyrillic letters) travel as a short hash.
const short=value=>createHash('sha256').update(value).digest('hex').slice(0,8);
const cut=(value,max)=>value.length>max?`${value.slice(0,max-1)}…`:value;
const money=value=>`${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
const keyboard=rows=>{rows=rows.filter(r=>r.length);return rows.length?{inline_keyboard:rows}:null;};
const pairs=buttons=>buttons.reduce((rows,b,i)=>{if(i%2)rows[rows.length-1].push(b);else rows.push([b]);return rows;},[]);
const splitTags=text=>text.split(',').map(t=>t.trim()).filter(Boolean);
const can=(staff,permission)=>permissions[staff.role]?.includes(permission);
const requireWrite=staff=>{if(!can(staff,'leads:write'))throw fail(403,'Роль наблюдателя: только просмотр');};
const getLead=(store,id)=>{const lead=store.get(id);if(!lead||lead.deleted_at)throw fail(404,'Лид не найден или удалён');return lead;};
const actor=c=>`${c.staff.username} (Telegram)`;
const active=store=>store.list().filter(l=>!l.archived);

function leadList(c,title,leads,extraRows=[]){
 const shown=leads.slice(0,10);
 c.say(shown.length?`${title}: ${leads.length}${leads.length>shown.length?' — показаны 10 последних':''}`:`${title}: ничего не найдено`,
  keyboard([...shown.map(l=>[{text:cut(`${l.name} · ${stages[l.status]}`,60),callback_data:`ld:${l.id}`}]),...extraRows]));
}
function showLeads(c,stage){
 const all=active(c.store),list=stage==='all'?all:all.filter(l=>l.status===stage);
 const filters=[{text:`Все ${all.length}`,callback_data:'ls:all'},...Object.entries(stages).map(([key,label])=>({text:`${label} ${all.filter(l=>l.status===key).length}`,callback_data:`ls:${key}`}))];
 leadList(c,stage==='all'?'📋 Активные лиды':`📋 ${stages[stage]}`,list,[filters.slice(0,4),filters.slice(4)]);
}
function showTags(c){
 const all=active(c.store),tags=[...new Set(all.flatMap(l=>l.tags))].sort();
 if(!tags.length)return c.say('Тегов пока нет.');
 c.say('🏷 Выберите тег:',keyboard(pairs(tags.slice(0,40).map(t=>({text:`${t} · ${all.filter(l=>l.tags.includes(t)).length}`,callback_data:`tg:${short(t)}`})))));
}
function showCard(c,lead){
 const owner=lead.owner_id?c.store.user(lead.owner_id):null;
 const lines=[`👤 ${lead.name}`,`📞 ${lead.contact}`,lead.company?`🏢 ${lead.company}`:null,`📝 ${cut(lead.request,1500)}`,'',
  `Этап: ${stages[lead.status]}${lead.paid?` · оплачено ${money(lead.paid_amount/100)}`:''}`,lead.budget?`Сумма сделки: ${money(lead.budget)}`:null,
  `Теги: ${lead.tags.join(', ')||'—'}`,`Ответственный: ${owner?`@${owner.username}`:'не назначен'}`,`Источник: ${sources[lead.source]??lead.source} · ${when(lead.created_at)}`,
  lead.notes?`Заметки: ${cut(lead.notes,500)}`:null,lead.archived?'🗄 В архиве':null].filter(line=>line!==null);
 const write=can(c.staff,'leads:write')&&!lead.archived;
 c.say(lines.join('\n'),keyboard(write?[
  [{text:'🔀 Этап',callback_data:`st:${lead.id}`},{text:'🏷 Тег +',callback_data:`at:${lead.id}`},...(lead.tags.length?[{text:'🏷 Тег −',callback_data:`tm:${lead.id}`}]:[])],
  [...(lead.owner_id!==c.staff.id?[{text:'🙋 Взять себе',callback_data:`me:${lead.id}`}]:[]),...(lead.client_chat_id&&can(c.staff,'chat:write')?[{text:'💬 Ответить клиенту',callback_data:`rp:${lead.id}`}]:[])]
 ]:[]));
}
function showTasks(c){
 const list=c.store.tasks().filter(t=>t.assignee_id===c.staff.id&&t.status!=='done').slice(0,15);
 if(!list.length)return c.say('✅ Открытых задач нет.');
 c.say(`✅ Ваши задачи: ${list.length}\n\n${list.map((t,i)=>{const lead=t.lead_id?c.store.get(t.lead_id):null;return `${i+1}. ${t.title}${t.due_at?` — ${when(t.due_at)}${Date.parse(t.due_at)<Date.now()?' ⚠️ просрочена':''}`:''}${lead?`\n    Лид: ${lead.name}`:''}`;}).join('\n')}`,
  keyboard(can(c.staff,'tasks:write')?list.map((t,i)=>[{text:cut(`✅ ${i+1}. ${t.title}`,60),callback_data:`td:${t.id}`}]):[]));
}
function search(c,text){
 const query=text.toLowerCase(),contact=normalizeContact(text);
 leadList(c,`🔎 «${cut(text,40)}»`,active(c.store).filter(l=>`${l.name} ${l.contact} ${l.company} ${l.request} ${l.tags.join(' ')}`.toLowerCase().includes(query)||normalizeContact(l.contact)===contact));
}
function createLead(c,data){
 const lead=c.store.create({...data,owner_id:c.staff.id},'manual',c.staff.id);
 c.store.activity(lead.id,actor(c),'Создан лид');c.say('✅ Лид создан.',MENU);showCard(c,lead);
}

function onText(c,text){
 const {store,staff,state}=c;
 if(/^\/(start|menu|help)\b/.test(text)||text==='ℹ️ Помощь'){
  c.say(`Здравствуйте, @${staff.username} · ${roleNames[staff.role]}.\n\nЗдесь работает CRM: лиды по этапам и тегам, поиск, карточка лида, новые лиды, теги, этапы и ваши задачи. Сюда же приходят все уведомления: обращения и сообщения клиентов, задачи, напоминания, чат команды и оплаты.\n\nЛюбой текст без команды — поиск по лидам. /cancel — отменить ввод.`,MENU);
  return null;
 }
 if(text==='/cancel'){c.say('Отменено.',MENU);return null;}
 if(text==='📋 Лиды'||text==='/leads'){showLeads(c,'all');return null;}
 if(text==='🏷 По тегу'||text==='/tags'){showTags(c);return null;}
 if(text==='✅ Мои задачи'||text==='/tasks'){showTasks(c);return null;}
 if(text==='➕ Новый лид'||text==='/new'){requireWrite(staff);c.say('Новый лид. Как зовут клиента? (/cancel — отмена)');return {step:'new_name'};}
 if(state?.step==='new_name'){if(text.length>120)throw fail(400,'Имя: до 120 символов');c.say('Контакт клиента: телефон, email или @username?');return {step:'new_contact',name:text};}
 if(state?.step==='new_contact'){if(text.length>200)throw fail(400,'Контакт: до 200 символов');c.say('Что нужно клиенту? Опишите запрос.');return {...state,step:'new_request',contact:text};}
 if(state?.step==='new_request'){if(text.length>4000)throw fail(400,'Запрос: до 4000 символов');c.say('Теги через запятую — или «-», если без тегов.');return {...state,step:'new_tags',request:text};}
 if(state?.step==='new_tags'){
  const data={name:state.name,contact:state.contact,request:state.request,tags:text==='-'?[]:splitTags(text)};
  try{validateLead(data);}catch(e){throw fail(400,e.message);}
  const duplicates=store.duplicates(data);
  if(duplicates.length){c.say(`Похожий лид уже есть: ${duplicates.slice(0,3).map(l=>`${l.name} (${l.contact})`).join(', ')}. Всё равно создать?`,keyboard([[{text:'Да, создать',callback_data:'nl:yes'},{text:'Нет',callback_data:'nl:no'}]]));return {step:'new_confirm',data};}
  createLead(c,data);return null;
 }
 if(state?.step==='add_tag'){
  requireWrite(staff);const lead=getLead(store,state.lead),added=splitTags(text);
  store.update(lead.id,{tags:[...lead.tags,...added]},staff.id);store.activity(lead.id,actor(c),`Добавлены теги: ${added.join(', ')}`);showCard(c,store.get(lead.id));return null;
 }
 if(state?.step==='reply'){
  const lead=getLead(store,state.lead);if(!lead.client_chat_id)throw fail(409,'Клиент не подключён к клиентскому боту');
  store.queueReply(lead.client_chat_id,text.slice(0,4000),staff.username,staff.id,`staff-reply:${c.updateId}`,'client_bot');
  c.say('✅ Ответ отправлен клиенту.',MENU);return null;
 }
 search(c,text);return null;
}

function onButton(c,data,queryId){
 const {store,staff}=c,[action,id,arg]=data.split(':');
 if(action==='ls'){showLeads(c,id in stages?id:'all');return c.state;}
 if(action==='tg'){
  const all=active(store),tag=[...new Set(all.flatMap(l=>l.tags))].find(t=>short(t)===id);
  if(tag)leadList(c,`🏷 ${tag}`,all.filter(l=>l.tags.includes(tag)));else c.say('Этот тег больше не используется.');
  return c.state;
 }
 if(action==='td'){if(!can(staff,'tasks:write'))throw fail(403,'Роль наблюдателя: только просмотр');store.saveTask({status:'done'},staff,id);c.say('✅ Задача выполнена.');return c.state;}
 if(action==='nl'){
  if(c.state?.step!=='new_confirm'){c.say('Этот ввод уже завершён.');return c.state;}
  if(id==='yes')createLead(c,c.state.data);else c.say('Лид не создан.',MENU);
  return null;
 }
 const lead=getLead(store,id);
 if(action==='ld'){showCard(c,lead);return c.state;}
 requireWrite(staff);if(lead.archived)throw fail(409,'Лид в архиве');
 if(action==='st'){c.say(`Новый этап для «${lead.name}»:`,keyboard(pairs(Object.entries(stages).filter(([key])=>key!==lead.status&&(key!=='paid'||lead.paid)).map(([key,label])=>({text:label,callback_data:`ss:${lead.id}:${key}`})))));return c.state;}
 if(action==='ss'){
  if(!(arg in stages))throw fail(400,'Неизвестный этап');if(arg==='paid'&&!lead.paid)throw fail(409,'Этап «Оплачено» доступен только после подтверждения банка');
  if(lead.status!==arg){store.update(lead.id,{status:arg},staff.id);store.activity(lead.id,actor(c),`Этап: ${stages[arg]}`);notifyStage(store,lead.id,arg,`stage:tg:${queryId}`);}
  showCard(c,store.get(lead.id));return c.state;
 }
 if(action==='at'){c.say(`Новые теги для «${lead.name}» через запятую (/cancel — отмена):`);return {step:'add_tag',lead:lead.id};}
 if(action==='tm'){c.say('Какой тег убрать?',keyboard(pairs(lead.tags.map(t=>({text:`✕ ${t}`,callback_data:`rt:${lead.id}:${short(t)}`})))));return c.state;}
 if(action==='rt'){
  const tag=lead.tags.find(t=>short(t)===arg);
  if(tag){store.update(lead.id,{tags:lead.tags.filter(t=>t!==tag)},staff.id);store.activity(lead.id,actor(c),`Убран тег: ${tag}`);}
  showCard(c,store.get(lead.id));return c.state;
 }
 if(action==='me'){store.update(lead.id,{owner_id:staff.id},staff.id);store.activity(lead.id,actor(c),`Ответственный: @${staff.username}`);showCard(c,store.get(lead.id));return c.state;}
 if(action==='rp'){
  if(!can(staff,'chat:write'))throw fail(403,'Роль наблюдателя: только просмотр');if(!lead.client_chat_id)throw fail(409,'Клиент не подключён к клиентскому боту');
  c.say(`Ответ клиенту «${lead.name}» — напишите текст (/cancel — отмена):`);return {step:'reply',lead:lead.id};
 }
 c.say('Эта кнопка устарела.');return c.state;
}

export function handleStaffUpdate(store,update,{clientBot}={}){
 const m=update.message,q=update.callback_query,from=m?.from??q?.from,chatInfo=m?.chat??q?.message?.chat;
 if(!from||from.is_bot||!Number.isSafeInteger(from.id)||chatInfo?.type!=='private')return;
 const chat=String(chatInfo.id),text=(m?.text??'').trim(),say=(body,markup=null)=>store.queueStaff(chat,body,markup);
 const wasBound=Boolean(store.db.prepare('SELECT 1 FROM users WHERE telegram_id=?').get(String(from.id)));
 const link=/^\/start(?:@\w+)?\s+staff_([\w-]+)$/.exec(text),staff=(link&&store.consumeStaffLink(link[1],from))||store.staffByTelegram(from);
 if(!staff){
  const client=clientBot?.username?`@${clientBot.username}`:'клиентском боте агентства';
  say(`${link?'Ссылка привязки недействительна или устарела — получите новую в профиле CRM.\n\n':''}Это рабочий бот команды Jumpads CRM.\n\nКлиентам: оставить заявку можно в ${client}.\nСотрудникам: укажите свой Telegram в CRM («Команда и роли» → профиль) и снова напишите сюда /start.`);
  return;
 }
 const key=`staff:${chat}`;
 const c={store,staff,say,updateId:update.update_id,state:JSON.parse(store.db.prepare('SELECT state FROM sessions WHERE chat_id=?').get(key)?.state??'null')};
 let state=c.state;
 try{
  if(!wasBound){say(`✅ Telegram привязан к аккаунту CRM @${staff.username}. Теперь сюда приходят все уведомления.`);state=onText(c,'/start');}
  else if(q)state=onButton(c,String(q.data??''),q.id);
  else if(!text){say('Пока понимаю только текст и кнопки меню.');}
  else state=onText(c,text);
 }catch(e){
  if(!e.status)console.error('Team bot action failed:',e);
  say(`⚠️ ${e.status?e.message:'Не получилось выполнить действие. Попробуйте ещё раз.'}`);
 }
 if(state)store.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(key,JSON.stringify(state));else store.db.prepare('DELETE FROM sessions WHERE chat_id=?').run(key);
}
