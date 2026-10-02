import { randomBytes,randomUUID } from 'node:crypto';
import { fail,hash } from './crm.js';
const names={new:'Новый',working:'В работе',proposal:'Предложение',won:'Сделка',paid:'Оплачено',closed:'Закрыт'};
const keyboard={keyboard:[[{text:'📝 Новая заявка'}],[{text:'📱 Поделиться телефоном',request_contact:true}],[{text:'/payments'},{text:'/subscribe'}]],resize_keyboard:true};
const contactKeyboard={keyboard:[[{text:'📱 Поделиться телефоном',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true};
const cut=(value,max)=>value.length>max?`${value.slice(0,max-1)}…`:value;
const WELCOME='Добро пожаловать! Здесь будут счета, статусы заявки и сообщения менеджера. Данные вашего Telegram-профиля сохранены в CRM. Телефон можно передать кнопкой ниже.\n/new — новая заявка\n/payments — мои счета\n/subscribe — подписаться на рассылки\n/unsubscribe — отписаться от рассылок\n/stop — отключить автоматические уведомления';
export function clientMember(store,leadId){return store.db.prepare('SELECT * FROM client_members WHERE lead_id=?').get(leadId);}
export function notifyClient(store,leadId,text,key){
 const member=clientMember(store,leadId);if(!member||member.blocked||!member.notifications_enabled)return null;
 const old=store.db.prepare('SELECT * FROM messages WHERE client_key=?').get(key);if(old)return old;
 return store.queueReply(member.chat_id,text,'Клиентский бот',null,key,'client_bot');
}
export function notifyStage(store,leadId,stage,key){return notifyClient(store,leadId,`Статус вашей заявки: ${names[stage]??stage}.`,key);}
export function createInvite(store,leadId,username){
 if(!store.get(leadId))throw fail(404,'Лид не найден');if(!username)throw fail(409,'Укажите CLIENT_BOT_USERNAME или запустите второго бота с токеном');
 const token=randomBytes(24).toString('base64url');store.db.prepare('INSERT INTO client_invites VALUES (?,?,?,NULL)').run(hash(token),leadId,Date.now()+86400000);
 return {url:`https://t.me/${username}?start=c_${token}`,expires_at:new Date(Date.now()+86400000).toISOString()};
}
export function acceptClientUpdate(store,update){
 if(!Number.isSafeInteger(update.update_id))throw new Error('Invalid update');const db=store.db;
 store.transaction(()=>{
  const offset=Number(db.prepare("SELECT value FROM meta WHERE key='client_offset'").get()?.value??0);if(update.update_id<offset)return;
  const m=update.message,memberEvent=update.my_chat_member;
  if(memberEvent?.chat?.type==='private'){
   const chat=String(memberEvent.chat.id),blocked=memberEvent.new_chat_member?.status==='kicked';db.prepare('UPDATE client_members SET blocked=?,last_seen=? WHERE chat_id=?').run(Number(blocked),new Date().toISOString(),chat);
   db.prepare('INSERT OR IGNORE INTO client_events VALUES (?,?,?,?)').run(update.update_id,chat,JSON.stringify(update),new Date().toISOString());
  }
  if(m?.chat?.type==='private'&&Number.isSafeInteger(m.from?.id)&&m.chat.id===m.from.id&&!m.from.is_bot){
   const chat=String(m.chat.id),userId=String(m.from.id),text=(m.text??'').trim(),now=new Date().toISOString();
   let member=db.prepare('SELECT * FROM client_members WHERE user_id=?').get(userId),lead=member?store.get(member.lead_id):null;
   const start=/^\/start(?:@\w+)?(?:\s+c_([\w-]+))?$/.exec(text);
   let invite=start?.[1]?db.prepare('SELECT * FROM client_invites WHERE token_hash=? AND expires_at>?').get(hash(start[1]),Date.now()):null;
   const target=invite?store.get(invite.lead_id):null;
   const validInvite=target&&(!invite.used_by||invite.used_by===userId)&&(!target.client_chat_id||target.client_chat_id===chat)&&(!member||member.lead_id===target.id)&&(!target.telegram_chat_id||target.telegram_chat_id===chat);
   if(validInvite){lead=target;db.prepare('UPDATE client_invites SET used_by=? WHERE token_hash=?').run(userId,invite.token_hash);}
   // A request left earlier in the former intake bot belongs to the same person.
   if(!lead)lead=store.list().find(l=>l.telegram_chat_id===chat&&!l.client_chat_id)??null;
   const ownContact=m.contact?.user_id===m.from.id?m.contact:null;
   const sessionKey=`client:${chat}`;
   let state=JSON.parse(db.prepare('SELECT state FROM sessions WHERE chat_id=?').get(sessionKey)?.state??'null');
   const bind=target=>{
    const contactProfile=ownContact?JSON.stringify(ownContact):member?.contact_profile??null;
    if(!member)db.prepare('INSERT INTO client_members(chat_id,user_id,lead_id,profile,chat_profile,contact_profile,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?)').run(chat,userId,target.id,JSON.stringify(m.from),JSON.stringify(m.chat),contactProfile,now,now);
    else db.prepare('UPDATE client_members SET lead_id=?,profile=?,chat_profile=?,contact_profile=?,blocked=0,last_seen=? WHERE chat_id=?').run(target.id,JSON.stringify(m.from),JSON.stringify(m.chat),contactProfile,now,chat);
    member=db.prepare('SELECT * FROM client_members WHERE chat_id=?').get(chat);
    db.prepare('UPDATE leads SET client_chat_id=?,client_profile=? WHERE id=?').run(chat,JSON.stringify({user:m.from,chat:m.chat,contact:contactProfile?JSON.parse(contactProfile):null}),target.id);
   };
   if(lead){
    const joined=!member;bind(lead);
    if(joined&&validInvite)store.notifyUsers([lead.owner_id],`🔗 Клиент ${lead.name} подключился к клиентскому боту`,{inline_keyboard:[[{text:'Открыть',callback_data:`ld:${lead.id}`}]]});
    if(ownContact?.phone_number&&!state){store.update(lead.id,{contact:ownContact.phone_number});store.activity(lead.id,'Клиентский бот','Клиент поделился своим телефоном');}
   }
   db.prepare('INSERT INTO client_events VALUES (?,?,?,?)').run(update.update_id,chat,JSON.stringify(update),now);
   store.addMessage({kind:'client_bot',chat_id:chat,author:[m.from.first_name,m.from.last_name].filter(Boolean).join(' ')||'Клиент',body:(text||ownContact?.phone_number||'[Нетекстовое сообщение: метаданные сохранены]').slice(0,4000),delivery:'received',client_key:`client:${update.update_id}`});
   const reply=(body,markup=null)=>store.queueReply(chat,body,'Клиентский бот',null,`client-reply:${update.update_id}`,'client_bot',markup);
   // Step-by-step request: name → contact → request. The lead appears only when all three are known.
   const begin=intro=>{state={step:'name'};reply(`${intro}Как вас зовут?`,{remove_keyboard:true});};
   if(start){
    db.prepare('UPDATE client_members SET notifications_enabled=1,blocked=0 WHERE chat_id=?').run(chat);
    const warning=start[1]&&!validInvite?'Персональная ссылка недействительна или уже связана с другим клиентом. Обратитесь к менеджеру.\n\n':'';
    if(lead){state=null;reply(`${warning}${WELCOME}`,keyboard);}
    else begin(`${warning}Здравствуйте! Оставьте заявку агентству: имя, контакт и задача. Данные попадут менеджеру в CRM. Для отмены — /cancel.\n\n`);
   }else if(text==='/new'||text==='📝 Новая заявка')begin('Новая заявка. Для отмены — /cancel.\n\n');
   else if(text==='/cancel'){state=null;reply('Заявка отменена. Начать заново: /new',lead?keyboard:null);}
   else if(['/stop','/subscribe','/unsubscribe','/payments'].includes(text)&&!member)reply('Сначала оставьте заявку: /new');
   else if(text==='/stop'){db.prepare('UPDATE client_members SET notifications_enabled=0,broadcast_enabled=0 WHERE chat_id=?').run(chat);reply('Автоматические уведомления и рассылки отключены. Включить уведомления: /start.');}
   else if(text==='/subscribe'){db.prepare('UPDATE client_members SET broadcast_enabled=1,notifications_enabled=1 WHERE chat_id=?').run(chat);reply('Вы подписались на рассылки. Отключить рассылки: /unsubscribe.');}
   else if(text==='/unsubscribe'){db.prepare('UPDATE client_members SET broadcast_enabled=0 WHERE chat_id=?').run(chat);reply('Рассылки отключены. Счета и уведомления по вашей заявке остаются включены.');}
   else if(text==='/payments'){
    const payments=db.prepare('SELECT * FROM payments WHERE lead_id=? ORDER BY created_at DESC LIMIT 8').all(lead.id);
    reply(payments.length?payments.map(p=>`${p.description}: ${(p.amount/100).toFixed(2)} ₽\n${p.status==='CONFIRMED'?'Оплачено':p.payment_url&&['NEW','FORM_SHOWED','AUTHORIZING','3DS_CHECKING','3DS_CHECKED'].includes(p.status)?p.payment_url:'Статус: '+p.status}`).join('\n\n').slice(0,4000):'Пока нет выставленных счетов.');
   }else if(state?.step==='name'){
    if(!text||text.length>120||text.startsWith('/'))reply('Напишите имя текстом (до 120 символов).');
    else{state={step:'contact',name:text};reply('Как с вами связаться? Напишите телефон, email или @username — или нажмите кнопку ниже.',contactKeyboard);}
   }else if(state?.step==='contact'){
    const value=ownContact?.phone_number||text;
    if(!value||value.length>200||value.startsWith('/'))reply('Напишите контакт текстом (до 200 символов) или нажмите «Поделиться телефоном».',contactKeyboard);
    else{state={...state,step:'request',contact:value};reply('Опишите задачу: что нужно сделать и какого результата вы ждёте?',{remove_keyboard:true});}
   }else if(state?.step==='request'){
    if(!text||text.length>4000||text.startsWith('/'))reply('Опишите задачу текстом (до 4000 символов).');
    else{
     // A repeat request is always saved: the customer never sees CRM duplicates, the manager decides by the tag.
     const data={name:state.name,contact:state.contact,request:text},duplicates=store.duplicates(data);
     lead=store.create({...data,tags:duplicates.length?['telegram','возможный дубль']:['telegram']},'telegram');
     store.activity(lead.id,'Клиентский бот',duplicates.length?`Получена заявка из Telegram. Возможный дубль: ${duplicates.slice(0,3).map(l=>l.name).join(', ')}`:'Получена заявка из Telegram');
     bind(lead);state=null;
     reply('Спасибо! Заявка передана менеджеру. Здесь можно продолжить переписку, сюда же придут счета и статусы. Новая заявка — /new.',keyboard);
     store.notifyTeam(`🆕 Новое обращение${duplicates.length?' · возможный дубль':''}\n👤 ${data.name}\n📞 ${data.contact}\n📝 ${cut(data.request,600)}`,{inline_keyboard:[[{text:'Открыть',callback_data:`ld:${lead.id}`},{text:'💬 Ответить',callback_data:`rp:${lead.id}`}]]});
    }
   }else if(!lead)begin('Помогу оставить заявку агентству. Данные получит менеджер. Для отмены — /cancel.\n\n');
   else if(ownContact)reply('Спасибо! Ваш телефон добавлен в карточку клиента.');
   else if(!text)reply('Пока поддерживаются текстовые сообщения. Опишите, пожалуйста, вопрос текстом.');
   else{
    // Every customer message is news for the team: the owner if there is one, otherwise everybody.
    const notice=`💬 ${lead.name} пишет в клиентского бота:\n${cut(text,1500)}`,markup={inline_keyboard:[[{text:'💬 Ответить',callback_data:`rp:${lead.id}`},{text:'Открыть',callback_data:`ld:${lead.id}`}]]};
    if(lead.owner_id)store.notifyUsers([lead.owner_id],notice,markup);else store.notifyTeam(notice,markup);
   }
   if(state)db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(sessionKey,JSON.stringify(state));else db.prepare('DELETE FROM sessions WHERE chat_id=?').run(sessionKey);
   if(start&&lead){for(const p of db.prepare("SELECT * FROM payments WHERE lead_id=? AND status IN ('NEW','FORM_SHOWED') AND payment_url IS NOT NULL").all(lead.id))notifyClient(store,lead.id,`Счёт: ${p.description}\nСумма: ${(p.amount/100).toFixed(2)} ₽\nТестовая оплата: ${p.payment_url}`,`invoice:${p.id}`);}
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('client_offset',?)").run(String(update.update_id+1));
 });
}
export function clientDetails(store,leadId){
 const member=clientMember(store,leadId);if(!member)return null;
 return {...member,profile:JSON.parse(member.profile),chat_profile:JSON.parse(member.chat_profile),contact_profile:member.contact_profile?JSON.parse(member.contact_profile):null,events:store.db.prepare('SELECT update_id,payload,created_at FROM client_events WHERE chat_id=? ORDER BY update_id DESC LIMIT 20').all(member.chat_id).map(e=>({...e,payload:JSON.parse(e.payload)}))};
}
export function campaignPreview(store,user,input){
 if(typeof input.body!=='string'||!input.body.trim()||input.body.length>3500)throw fail(400,'Текст рассылки: от 1 до 3500 символов');
 if(input.tag!=null&&typeof input.tag!=='string')throw fail(400,'Некорректный тег');
 const members=store.db.prepare('SELECT * FROM client_members WHERE broadcast_enabled=1 AND notifications_enabled=1 AND blocked=0').all().filter(m=>{const lead=store.get(m.lead_id);return lead&&!lead.archived&&(!input.tag||lead.tags.includes(input.tag));});
 const id=randomUUID();store.db.prepare('INSERT INTO campaigns VALUES (?,?,?,?,?,?,?,NULL)').run(id,input.body.trim(),input.tag||null,JSON.stringify(members.map(m=>m.chat_id)),'draft',user.id,new Date().toISOString());
 return {id,count:members.length,recipients:members.map(m=>({name:store.get(m.lead_id).name,chat_id:m.chat_id})),body:input.body.trim()};
}
export function sendCampaign(store,user,id){return store.transaction(()=>{
 const campaign=store.db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);if(!campaign)throw fail(404,'Рассылка не найдена');if(campaign.created_by!==user.id)throw fail(403,'Черновик другого пользователя');
 if(campaign.state==='sent')return {id,alreadySent:true};if(Date.now()-Date.parse(campaign.created_at)>600000)throw fail(409,'Предпросмотр устарел. Сформируйте его заново');
 let queued=0;for(const chat of JSON.parse(campaign.recipients)){
  const member=store.db.prepare('SELECT * FROM client_members WHERE chat_id=? AND broadcast_enabled=1 AND notifications_enabled=1 AND blocked=0').get(chat);if(!member)continue;const lead=store.get(member.lead_id);if(lead.archived||(campaign.tag&&!lead.tags.includes(campaign.tag)))continue;
  store.queueReply(chat,campaign.body+'\n\nОтписаться от рассылок: /unsubscribe',user.username,user.id,`campaign:${id}:${chat}`,'client_bot');queued++;
 }
 store.db.prepare("UPDATE campaigns SET state='sent',sent_at=? WHERE id=?").run(new Date().toISOString(),id);return {id,queued};
});}
