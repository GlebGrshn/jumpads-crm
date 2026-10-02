import { initWorkflow,loadWorkflow,renderWorkflow,filterKanban,decorateKanban } from './workflow.js';
const $=id=>document.getElementById(id);
const stages={new:'Новый',working:'В работе',proposal:'Предложение',won:'Сделка',paid:'Оплачено',closed:'Закрыт'};
const roles={admin:'Администратор',manager:'Менеджер',observer:'Наблюдатель'};
const taskStatuses={todo:'К выполнению',doing:'В работе',done:'Выполнена'};
const sources={manual:'Вручную',telegram:'Telegram-бот',client_bot:'Клиентский бот'};
const titles={leads:'Лиды',pipeline:'Воронка продаж',tasks:'Задачи',messages:'Мессенджер',team:'Команда и роли',automation:'Роботы и автоматизация'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>new Intl.NumberFormat('ru',{style:'currency',currency:'RUB',minimumFractionDigits:0,maximumFractionDigits:2}).format(v??0);
const date=v=>v?new Date(v).toLocaleString('ru',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Без срока';
const options=(values,selected)=>Object.entries(values).map(([v,label])=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(label)}</option>`).join('');
let me=null,rights=[],testRoles=false,leads=[],users=[],tasks=[],notifications=[],conversations=[],clientConversations=[],integrations={clientBot:{state:'disabled'},payments:{configured:false,issues:[]}},bot={},view='leads',mode='login',loading=false,editing=null,editingTask=null,leadKey=null,chatKind='team',chatTarget='',chatSignature='',authVersion=0;
const seenNotifications=new Set();let messageKey=crypto.randomUUID();
const can=right=>rights.includes(right);
const userName=id=>users.find(u=>u.id===id)?.username??'Не назначен';
const taskEditable=t=>can('tasks:write')&&(!t||me.role==='admin'||t.created_by===me.id||t.assignee_id===me.id);
let entryUrl='',offlineSince=0;
async function api(path,options={}){
 let response,data;
 // A public tunnel may come back under a new address, and its dead address answers with a non-JSON gateway page:
 // after a sustained outage return to the stable entry page, which knows the current address.
 try{response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});if(!response.headers.get('content-type')?.includes('application/json'))throw new Error();data=await response.json();offlineSince=0;}
 catch{offlineSince||=Date.now();if(entryUrl&&Date.now()-offlineSince>8000)location.replace(`${entryUrl}?from=${encodeURIComponent(location.host)}`);throw Object.assign(new Error('Нет связи с CRM, переподключаемся…'),{status:0});}
 if(!response.ok){if(response.status===401&&!['/api/login','/api/register'].includes(path))showLogin();throw Object.assign(new Error(data.error??'Не удалось выполнить запрос'),{status:response.status,...data});}return data;
}
const send=(path,method,data)=>api(path,{method,body:JSON.stringify(data)});
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
function showLogin(){me=null;authVersion++;$('workspace').hidden=true;$('login').hidden=false;document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
function setAuthMode(next){mode=next;$('register-fields').hidden=mode!=='register';$('password-repeat').required=mode==='register';$('reg-telegram').required=mode==='register';$('auth-submit').textContent=mode==='register'?'Создать аккаунт':'Войти в CRM →';$('password').autocomplete=mode==='register'?'new-password':'current-password';$('login-mode').classList.toggle('selected',mode==='login');$('register-mode').classList.toggle('selected',mode==='register');$('login-error').textContent='';}
function showView(next){view=next;document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!==`${view}-view`);document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('nav-active',e.dataset.view===view));$('page-title').textContent=titles[view];$('breadcrumb').textContent=titles[view];$('add').hidden=!['leads','pipeline'].includes(view)||!can('leads:write');$('add-task').hidden=view!=='tasks'||!can('tasks:write');if(view==='messages')loadMessages().catch(e=>toast(e.message));}
function render(){
 $('current-user').textContent=me.username;$('current-role').textContent=roles[me.role];$('test-banner').hidden=!testRoles;
 const active=leads.filter(l=>!l.archived);$('total').textContent=active.length;$('nav-count').textContent=active.length;$('new-count').textContent=active.filter(l=>l.status==='new').length;$('working-count').textContent=active.filter(l=>['working','proposal'].includes(l.status)).length;$('telegram-count').textContent=active.filter(l=>['telegram','client_bot'].includes(l.source)).length;
 const descriptions={disabled:'Не подключён · CRM работает, уведомления в Telegram не приходят',connecting:'Подключаемся к Telegram…',connected:'Подключён · лиды, задачи и все уведомления CRM для сотрудников в Telegram',conflict:'Конфликт: проверьте webhook и другие экземпляры бота',invalid_token:'Токен не принят. Проверьте настройки на сервере.',retrying:'Связь прервана · повторяем подключение'};
 $('bot-status').textContent=descriptions[bot.state]??'Проверяем подключение…';$('bot-link').hidden=!bot.username;if(bot.username)$('bot-link').href=`https://t.me/${encodeURIComponent(bot.username)}`;
 renderCommerceStatus();renderLeads();renderWorkflow();renderPipeline();decorateKanban();renderTasks();renderTeam();renderNotifications();renderChats();showView(view);
}
function renderLeads(){
 const tag=$('tag').value,tags=[...new Set(leads.flatMap(l=>l.tags))].sort();$('tag').innerHTML='<option value="">Все теги</option>'+tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');if(tags.includes(tag))$('tag').value=tag;
 const q=$('search').value.trim().toLowerCase();
 const filtered=leads.filter(l=>(Boolean(l.archived)===($('archive-filter').value==='archived'))&&(!q||`${l.name} ${l.contact} ${l.request} ${l.company}`.toLowerCase().includes(q))&&(!$('source').value||l.source===$('source').value)&&(!$('status').value||l.status===$('status').value)&&(!$('tag').value||l.tags.includes($('tag').value)));
 $('visible-count').textContent=filtered.length;$('footer-count').textContent=`Показано ${filtered.length} из ${leads.length}`;$('empty').hidden=filtered.length>0;
 $('rows').innerHTML=filtered.map(l=>`<tr><td><b class="lead-name">${esc(l.name)}</b><span class="contact">${esc(l.contact)}</span><small class="source-label">${sources[l.source]??l.source}</small></td><td><span class="request-preview">${esc(l.request)}</span><small class="muted">${esc(l.company)}</small></td><td>${l.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')||'—'}</td><td><span class="badge ${l.status}">${stages[l.status]}</span><small class="contact">${money(l.budget)}</small>${l.paid?`<span class="badge paid">Оплачено ${money(l.paid_amount/100)}</span>`:``}</td><td>${esc(userName(l.owner_id))}</td><td><button class="quiet" data-edit="${l.id}" aria-label="Открыть лида ${esc(l.name)}">Открыть ↗</button></td></tr>`).join('');
}
function renderPipeline(){
 const active=filterKanban(leads);$('pipeline-summary').textContent=`${active.length} лидов · План ${money(active.reduce((sum,l)=>sum+l.budget,0))} · Оплачено ${money(active.reduce((sum,l)=>sum+l.paid_amount/100,0))}`;
 $('pipeline').innerHTML=Object.entries(stages).map(([stage,label])=>{const list=active.filter(l=>l.status===stage);return `<section class="pipeline-column"><div class="pipeline-heading"><h2>${label} <span>${list.length}</span></h2><small>${money(list.reduce((sum,l)=>sum+(stage==='paid'?l.paid_amount/100:l.budget),0))}</small></div>${list.map(l=>`<article class="pipeline-card"><button class="card-link" data-edit="${l.id}">${esc(l.name)}</button><p>${esc(l.company||l.request)}</p><b>${money(l.budget)}</b>${l.paid?`<span class="badge paid">Оплачено ${money(l.paid_amount/100)}</span>`:``}<small>${esc(userName(l.owner_id))}</small><label class="sr-only" for="stage-${l.id}">Этап для ${esc(l.name)}</label><select id="stage-${l.id}" data-stage="${l.id}" ${can('leads:write')?'':'disabled'}>${options(Object.fromEntries(Object.entries(stages).filter(([key])=>key!=='paid'||l.paid)),l.status)}</select></article>`).join('')||'<p class="column-empty">Нет лидов</p>'}</section>`;}).join('');
}
function renderTasks(){
 const scope=$('task-scope').value,filter=$('task-filter').value;
 const overdue=t=>t.status!=='done'&&t.due_at&&Date.parse(t.due_at)<Date.now();
 const list=tasks.filter(t=>(scope==='all'||(scope==='mine'?t.assignee_id===me.id:t.created_by===me.id))&&(filter==='all'||(filter==='done'?t.status==='done':filter==='overdue'?overdue(t):t.status!=='done')));
 $('task-count').textContent=tasks.filter(t=>t.assignee_id===me.id&&t.status!=='done').length;
 $('task-list').innerHTML=list.map(t=>`<article class="task-card"><div><span class="badge ${overdue(t)?'overdue':t.status==='done'?'won':'new'}">${overdue(t)?'Просрочена':taskStatuses[t.status]}</span>${t.priority==='high'?'<span class="badge working">Высокий приоритет</span>':''}<h2><button class="card-link" data-task="${t.id}">${esc(t.title)}</button></h2><p>${esc(t.description)}</p><small>Исполнитель: ${esc(userName(t.assignee_id))} · Срок: ${date(t.due_at)}</small>${t.lead_id?`<button class="quiet" data-edit="${t.lead_id}">Лид: ${esc(leads.find(l=>l.id===t.lead_id)?.name??'—')}</button>`:''}${t.remind_at?`<small>Напоминание: ${date(t.remind_at)}</small>`:''}</div><div><button class="button" data-task="${t.id}">Открыть</button>${t.status!=='done'&&taskEditable(t)?`<button class="primary" data-complete="${t.id}">Выполнено</button>`:''}</div></article>`).join('')||'<div class="empty"><h2>Задач пока нет</h2><p>Создайте задачу или измените фильтры.</p></div>';
}
function renderTeam(){
 $('profile-name').textContent=`@${me.username} · ${roles[me.role]}`;$('self-role-field').hidden=!testRoles;$('self-role').value=me.role;
 if(document.activeElement!==$('profile-telegram'))$('profile-telegram').value=me.telegram?'@'+me.telegram:'';
 const teamBot=bot.username?'@'+bot.username:'Telegram-бот команды',openBot=bot.username?'@'+bot.username:'бота команды';
 $('telegram-status').textContent=!me.telegram?'Не указан. Укажите юзернейм — через него приходят уведомления и работает бот команды.':me.telegram_linked?`✅ Привязан: уведомления CRM приходят в ${teamBot}.`:`Ещё не привязан: откройте ${openBot} с аккаунта @${me.telegram} и нажмите «Старт».`;$('telegram-link').hidden=!bot.username;
 $('team-list').innerHTML=users.map(u=>`<article class="team-card"><span class="avatar">${esc(u.username.slice(0,2).toUpperCase())}</span><div><b>@${esc(u.username)}</b><small>${roles[u.role]}${u.id===me.id?' · это вы':''}</small><small>${u.telegram?`Telegram: @${esc(u.telegram)}${u.telegram_linked?' ✓':' · не привязан'}`:'Telegram не указан'}</small></div>${can('users:roles')?`<label><span class="sr-only">Роль ${esc(u.username)}</span><select data-user-role="${u.id}">${options(roles,u.role)}</select></label>`:''}</article>`).join('');
}
function renderNotifications(){
 const unread=notifications.filter(n=>!n.read_at);$('notification-count').textContent=unread.length;
 $('notification-list').innerHTML=notifications.map(n=>`<article class="notification-item ${n.read_at?'read':''}"><b>${esc(n.title)}</b><p>${date(n.remind_at)}</p><button class="button" data-notification-task="${n.task_id}">Открыть задачу</button>${!n.read_at?`<button class="quiet" data-read="${n.id}">Прочитано</button>`:'<small>Прочитано</small>'}</article>`).join('')||'<p class="muted">Напоминаний пока нет. Укажите время напоминания в задаче.</p>';
 for(const n of unread){const key=`${me.id}:${n.id}`;if(seenNotifications.has(key))continue;seenNotifications.add(key);toast(n.title);if('Notification'in window&&Notification.permission==='granted')new Notification('Jumpads — напоминание',{body:n.title,tag:key});}
}
async function load(){
 if(loading)return;loading=true;const version=authVersion;$('refresh').disabled=true;
 try{
  const profile=await api('/api/me');
  const [list,people,work,reminders,chats,status,commerce,clientChats]=await Promise.all([api('/api/leads'),api('/api/users'),api('/api/tasks'),api('/api/notifications'),api('/api/conversations'),api('/api/status'),api('/api/integrations'),api('/api/conversations?kind=client_bot')]);
  if(version!==authVersion)return;
  me=profile.user;rights=profile.permissions;testRoles=profile.testRoles;leads=list;users=people;tasks=work;notifications=reminders;conversations=chats;bot=status;integrations=commerce;clientConversations=clientChats;
  await loadWorkflow();if(version!==authVersion)return;
  $('workspace').hidden=false;$('login').hidden=true;$('global-error').textContent='';render();
 }catch(e){if(e.status!==401)$('global-error').textContent=e.message;if(!me){$('login').hidden=false;if(e.status!==401)$('login-error').textContent=e.message;}}
 finally{loading=false;$('refresh').disabled=false;}
}
async function openEditor(id=null){
 $('delete-lead').hidden=!id||!can('leads:delete');
 editing=id;leadKey=crypto.randomUUID();const lead=leads.find(l=>l.id===id);if(id&&!lead){toast('Лид не найден');return;}
 $('invite-result').hidden=true;$('client-profile').textContent='';$('lead-paid-badge').textContent=lead?.paid?'Оплачено '+money(lead.paid_amount/100):'Не оплачено';$('lead-paid-badge').className=lead?.paid?'badge paid':'badge';$('lead-invite').hidden=!can('leads:write');$('lead-client-chat').hidden=!lead?.client_chat_id;
 $('lead-form').reset();for(const key of ['name','contact','request','company','notes'])$(key).value=lead?.[key]??'';
 $('tags').value=lead?.tags.join(', ')??'';$('budget').value=lead?.budget??0;$('lead-status').innerHTML=options(Object.fromEntries(Object.entries(stages).filter(([key])=>key!=='paid'||lead?.paid)),lead?.status??'new');
 $('owner').innerHTML='<option value="">Не назначен</option>'+users.map(u=>`<option value="${u.id}">${esc(u.username)}</option>`).join('');$('owner').value=lead?(lead.owner_id??''):me.id;
 $('lead-fields').disabled=!can('leads:write');$('save').hidden=!can('leads:write');$('lead-task').hidden=!id||!can('tasks:write');$('archive-lead').hidden=!id||!can('leads:archive');$('archive-lead').textContent=lead?.archived?'Восстановить':'В архив';$('lead-chat').hidden=!lead?.telegram_chat_id;$('lead-detail').hidden=!id;
 $('editor-title').textContent=id?'Карточка клиента':'Новая заявка';$('form-error').textContent='';$('lead-history').textContent='Загрузка…';
 $('lead-tasks').innerHTML=tasks.filter(t=>t.lead_id===id).map(t=>`<button type="button" class="button" data-task="${t.id}">${esc(t.title)} · ${taskStatuses[t.status]}</button>`).join('')||'<p class="muted">Нет связанных задач</p>';
 $('editor').showModal();if(can('leads:write'))$('name').focus();
 if(id)loadClientProfile(id);
 if(id){try{const history=await api(`/api/leads/${id}/history`);if(editing===id)$('lead-history').innerHTML=history.map(h=>`<p><b>${esc(h.actor)}</b> · ${esc(h.body)}<small>${date(h.created_at)}</small></p>`).join('')||'<p>История пока пуста</p>';}catch(e){$('lead-history').textContent=e.message;}}
}
function confirmDuplicate(duplicates){
 $('duplicate-yes').textContent=editing?'Да, сохранить':'Да, создать дубль';
 $('duplicate-list').innerHTML=duplicates.map(l=>`<p><b>${esc(l.name)}</b> · ${esc(l.contact)}${l.archived?' · в архиве':''}</p>`).join('');$('duplicate-dialog').returnValue='no';$('duplicate-dialog').showModal();
 return new Promise(resolve=>$('duplicate-dialog').addEventListener('close',()=>resolve($('duplicate-dialog').returnValue==='yes'),{once:true}));
}
const localDate=value=>{if(!value)return '';const d=new Date(value);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function openTask(id=null,leadId=null){
 const task=tasks.find(t=>t.id===id);if(id&&!task){toast('Задача не найдена');return;}editingTask=id;$('task-form').reset();
 $('task-title-heading').textContent=id?'Задача':'Новая задача';$('task-title').value=task?.title??'';$('task-description').value=task?.description??'';
 $('task-assignee').innerHTML=users.map(u=>`<option value="${u.id}">${esc(u.username)}</option>`).join('');$('task-assignee').value=task?.assignee_id??me.id;
 $('task-lead').innerHTML='<option value="">Без лида</option>'+leads.map(l=>`<option value="${l.id}">${esc(l.name)}${l.archived?' (архив)':''}</option>`).join('');$('task-lead').value=task?.lead_id??leadId??'';
 $('task-due').value=localDate(task?.due_at);$('task-remind').value=localDate(task?.remind_at);$('task-status').value=task?.status??'todo';$('task-priority').value=task?.priority??'normal';$('task-error').textContent='';$('task-fields').disabled=!taskEditable(task);$('save-task').hidden=!taskEditable(task);$('task-editor').showModal();
}
function renderChats(){
 $('client-chat-tab').classList.toggle('selected',chatKind==='client_bot');$('broadcast-button').hidden=!can('users:roles');
 $('team-chat-tab').classList.toggle('selected',chatKind==='team');$('telegram-chat-tab').classList.toggle('selected',chatKind==='telegram');$('telegram-chat-tab').hidden=!conversations.length&&chatKind!=='telegram';
 const list=chatKind==='team'?[{id:'',title:'Общий чат команды',hint:'Все участники'},...users.filter(u=>u.id!==me.id).map(u=>({id:u.id,title:'@'+u.username,hint:roles[u.role]}))]:(chatKind==='client_bot'?clientConversations:conversations).map(c=>({id:c.chat_id,title:c.lead?.name??c.last.author,hint:c.last.body.slice(0,65)}));
 if(chatKind!=='team'&&!list.some(c=>c.id===chatTarget))chatTarget=list[0]?.id??'';
 $('chat-list').innerHTML=list.map(c=>`<button class="chat-choice ${c.id===chatTarget?'selected':''}" data-chat="${esc(c.id)}"><b>${esc(c.title)}</b><small>${esc(c.hint)}</small></button>`).join('')||'<p class="muted chat-empty">Диалогов пока нет. Клиент должен написать боту.</p>';
 $('chat-title').textContent=list.find(c=>c.id===chatTarget)?.title??'Нет диалогов';
 $('chat-hint').textContent=chatKind!=='team'?'Текстовые сообщения через бота. Отправка обычно занимает до 5 секунд.':chatTarget?'Личная переписка: доступна только вам и собеседнику.':'Сообщения видны всем участникам команды.';
 const unavailable=!can('chat:write')||(chatKind!=='team'&&(!chatTarget||(chatKind==='client_bot'?integrations.clientBot:bot).state==='disabled'));
 $('message-body').disabled=unavailable;$('send-message').disabled=unavailable;
 $('message-body').placeholder=!can('chat:write')?'Роль наблюдателя: только чтение':chatKind!=='team'&&(chatKind==='client_bot'?integrations.clientBot:bot).state==='disabled'?'Подключите бота для отправки сообщений':'Напишите сообщение…';
}
async function loadMessages(){
 if(!me||view!=='messages')return;const selection=`${chatKind}:${chatTarget}`,version=authVersion;
 if(chatKind!=='team'&&!chatTarget){$('chat-messages').innerHTML='<p class="muted">Здесь появится история диалога.</p>';return;}
 const list=await api(`/api/messages?kind=${chatKind}&target=${encodeURIComponent(chatTarget)}`);
 if(selection!==`${chatKind}:${chatTarget}`||version!==authVersion)return;
 const signature=selection+JSON.stringify(list);if(signature===chatSignature)return;chatSignature=signature;
 const box=$('chat-messages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<70;
 box.innerHTML=list.map(m=>`<article class="message ${m.sender_id===me.id?'mine':''}"><b>${esc(m.author)}</b><p>${esc(m.body)}</p><small>${date(m.created_at)} · ${{sent:'Отправлено',received:'Входящее',pending:'В очереди',failed:'Не доставлено',canceled:'Отменено'}[m.delivery]??m.delivery}</small></article>`).join('')||'<p class="muted">Начните переписку.</p>';
 if(nearBottom||!box.dataset.selection||box.dataset.selection!==selection)box.scrollTop=box.scrollHeight;box.dataset.selection=selection;
}
function chooseChat(kind,target=''){
 chatKind=kind;chatTarget=target;chatSignature='';messageKey=crypto.randomUUID();$('message-body').value='';$('message-error').textContent='';renderChats();showView('messages');
}
function handle(fn){return async e=>{try{await fn(e);}catch(err){toast(err.message);}};}
$('status').insertAdjacentHTML('beforeend',options(stages));
$('login-mode').onclick=()=>setAuthMode('login');$('register-mode').onclick=()=>setAuthMode('register');
$('auth-form').onsubmit=async e=>{
 e.preventDefault();$('login-error').textContent='';if(mode==='register'&&$('password').value!==$('password-repeat').value){$('login-error').textContent='Пароли не совпадают';return;}
 $('auth-submit').disabled=true;
 try{await send(mode==='register'?'/api/register':'/api/login','POST',{username:$('username').value,password:$('password').value,role:$('registration-role').value,telegram:$('reg-telegram').value});authVersion++;$('password').value='';$('password-repeat').value='';await load();}
 catch(err){$('login-error').textContent=err.message;}finally{$('auth-submit').disabled=false;}
};
$('logout').onclick=handle(async()=>{await send('/api/logout','POST',{});showLogin();});
$('add').onclick=()=>openEditor();$('add-task').onclick=()=>openTask();$('refresh').onclick=load;
$('setup').onclick=()=>$('instructions').showModal();$('notifications-button').onclick=()=>$('notifications-dialog').showModal();
$('duplicate-yes').onclick=()=>$('duplicate-dialog').close('yes');$('duplicate-no').onclick=()=>$('duplicate-dialog').close('no');
$('lead-form').onsubmit=async e=>{
 e.preventDefault();$('save').disabled=true;$('form-error').textContent='';
 const data={name:$('name').value,contact:$('contact').value,company:$('company').value,request:$('request').value,notes:$('notes').value,budget:Number($('budget').value),owner_id:$('owner').value||null,status:$('lead-status').value,tags:$('tags').value.split(',').map(t=>t.trim()).filter(Boolean),clientRequestId:leadKey};
 const save=()=>send(editing?`/api/leads/${editing}`:'/api/leads',editing?'PATCH':'POST',data);
 try{try{await save();}catch(err){if(err.code!=='DUPLICATE_LEAD')throw err;if(!await confirmDuplicate(err.duplicates))return;data.confirmDuplicate=true;await save();}$('editor').close();toast('Лид сохранён');await load();}
 catch(err){$('form-error').textContent=err.message;}finally{$('save').disabled=false;}
};
$('lead-form').addEventListener('input',()=>{leadKey=crypto.randomUUID();});
$('archive-lead').onclick=handle(async()=>{const lead=leads.find(l=>l.id===editing);await send(`/api/leads/${editing}/archive`,'PATCH',{archived:!lead.archived});$('editor').close();await load();toast(lead.archived?'Лид восстановлен':'Лид в архиве');});
$('delete-lead').onclick=handle(async()=>{
 const lead=leads.find(l=>l.id===editing);if(!lead)return;
 if(!confirm(`Удалить лида «${lead.name}»?\n\nКарточка исчезнет из списка, канбана и архива. Связанные задачи, переписка и платежи сохранятся.`))return;
 $('delete-lead').disabled=true;
 try{await send(`/api/leads/${lead.id}`,'DELETE',{confirm:true});$('editor').close();await load();toast('Лид удалён');}finally{$('delete-lead').disabled=false;}
});
$('lead-task').onclick=()=>{const leadId=editing;$('editor').close();openTask(null,leadId);};
$('lead-chat').onclick=()=>{const lead=leads.find(l=>l.id===editing);$('editor').close();chooseChat('telegram',lead.telegram_chat_id);};
$('task-form').onsubmit=async e=>{
 e.preventDefault();$('save-task').disabled=true;$('task-error').textContent='';
 try{const data={title:$('task-title').value,description:$('task-description').value,assignee_id:$('task-assignee').value,lead_id:$('task-lead').value||null,due_at:$('task-due').value?new Date($('task-due').value).toISOString():null,remind_at:$('task-remind').value?new Date($('task-remind').value).toISOString():null,status:$('task-status').value,priority:$('task-priority').value};await send(editingTask?`/api/tasks/${editingTask}`:'/api/tasks',editingTask?'PATCH':'POST',data);$('task-editor').close();toast('Задача сохранена');await load();}catch(err){$('task-error').textContent=err.message;}finally{$('save-task').disabled=false;}
};
$('task-due').onchange=()=>{if($('task-due').value&&!$('task-remind').value)$('task-remind').value=localDate(new Date(new Date($('task-due').value).getTime()-15*60000).toISOString());};
$('self-role').onchange=handle(async()=>{const profile=await send('/api/me/role','PATCH',{role:$('self-role').value});me=profile.user;rights=profile.permissions;await load();toast(`Текущая роль: ${roles[me.role]}`);});
$('telegram-form').onsubmit=async e=>{
 e.preventDefault();$('save-telegram').disabled=true;$('telegram-error').textContent='';
 try{const result=await send('/api/me/telegram','PATCH',{telegram:$('profile-telegram').value});me=result.user;$('profile-telegram').blur();await load();toast(me.telegram?'Telegram сохранён':'Telegram удалён из профиля');}
 catch(err){$('telegram-error').textContent=err.message;}finally{$('save-telegram').disabled=false;}
};
$('telegram-link').onclick=handle(async()=>{const {url}=await send('/api/me/telegram-link','POST',{});window.open(url,'_blank','noopener');toast('Откройте бота и нажмите «Старт». Ссылка действует 24 часа и только один раз.');});
// Theme: auto (system) → light → dark; theme.js applies it before the page is drawn.
const themeNames={auto:'авто',light:'светлая',dark:'тёмная'};
function renderTheme(){for(const id of ['theme-toggle','login-theme'])$(id).textContent=`◐ Тема: ${themeNames[window.jumpadsTheme.get()]}`;}
for(const id of ['theme-toggle','login-theme'])$(id).onclick=()=>{const order=['auto','light','dark'];window.jumpadsTheme.set(order[(order.indexOf(window.jumpadsTheme.get())+1)%order.length]);renderTheme();};
renderTheme();
$('enable-notifications').onclick=handle(async()=>{if(!('Notification'in window)){toast('Этот браузер не поддерживает системные уведомления');return;}const permission=await Notification.requestPermission();toast(permission==='granted'?'Уведомления включены':'Разрешение не получено. Напоминания доступны в CRM.');});
$('team-chat-tab').onclick=()=>chooseChat('team');$('telegram-chat-tab').onclick=()=>chooseChat('telegram');
$('message-body').oninput=()=>{messageKey=crypto.randomUUID();};
$('message-form').onsubmit=async e=>{
 e.preventDefault();$('send-message').disabled=true;$('message-error').textContent='';const selection=`${chatKind}:${chatTarget}`,text=$('message-body').value;
 try{await send('/api/messages','POST',{kind:chatKind,target:chatTarget||null,body:text,clientRequestId:messageKey});if(selection===`${chatKind}:${chatTarget}`&&$('message-body').value===text){$('message-body').value='';messageKey=crypto.randomUUID();}await load();await loadMessages();$('chat-messages').scrollTop=$('chat-messages').scrollHeight;}
 catch(err){$('message-error').textContent=err.message;}finally{renderChats();}
};
for(const id of ['search','source','status','tag','archive-filter'])$(id).addEventListener('input',renderLeads);
for(const id of ['task-scope','task-filter'])$(id).addEventListener('input',renderTasks);
document.addEventListener('click',handle(async e=>{
 const close=e.target.closest('[data-close]');if(close){$(close.dataset.close).close();return;}
 const nav=e.target.closest('[data-view]');if(nav){showView(nav.dataset.view);return;}
 const edit=e.target.closest('[data-edit]');if(edit){document.querySelectorAll('dialog[open]').forEach(d=>d.close());await openEditor(edit.dataset.edit);return;}
 const task=e.target.closest('[data-task],[data-notification-task]');if(task){document.querySelectorAll('dialog[open]').forEach(d=>d.close());openTask(task.dataset.task??task.dataset.notificationTask);return;}
 const done=e.target.closest('[data-complete]');if(done){done.disabled=true;try{await send(`/api/tasks/${done.dataset.complete}`,'PATCH',{status:'done'});await load();}finally{done.disabled=false;}return;}
 const read=e.target.closest('[data-read]');if(read){await send(`/api/notifications/${read.dataset.read}/read`,'POST',{});await load();return;}
 const chat=e.target.closest('[data-chat]');if(chat)chooseChat(chatKind,chat.dataset.chat);
}));
document.addEventListener('change',handle(async e=>{
 if(e.target.matches('[data-stage]')){const id=e.target.dataset.stage;try{await send(`/api/leads/${id}`,'PATCH',{status:e.target.value,clientRequestId:crypto.randomUUID()});await load();}catch(err){renderPipeline();throw err;}}
 if(e.target.matches('[data-user-role]')){try{await send(`/api/users/${e.target.dataset.userRole}/role`,'PATCH',{role:e.target.value});await load();}catch(err){renderTeam();throw err;}}
}));
setInterval(()=>{
 if(!me)return;
 if($('payments-dialog').open)paymentList().catch(()=>{});
 if(!document.querySelector('dialog[open]'))load();
 else {const version=authVersion;api('/api/notifications').then(list=>{if(me&&version===authVersion){notifications=list;renderNotifications();}}).catch(()=>{});}
},5000);
// A first-time visitor (the reviewer) sees what to try and where the bots are.
function renderHowTo(config){
 const bot=name=>`<a href="https://t.me/${encodeURIComponent(name)}" target="_blank" rel="noopener">@${esc(name)}</a>`;
 $('how-to-steps').innerHTML=[`Зарегистрируйтесь: любой юзернейм${config.testRoles?' и любая роль':''}, в поле Telegram — ваш @username.`,config.bots?.client&&`Оставьте заявку в клиентском боте ${bot(config.bots.client)}: /start → имя → контакт → запрос.`,'Лид появится в разделе «Лиды» с тегом telegram. Добавьте свой тег и отфильтруйте по нему; лида можно завести и вручную.',config.bots?.team&&`Напишите /start боту команды ${bot(config.bots.team)} с того же Telegram: лиды, задачи и все уведомления CRM.`].filter(Boolean).map(step=>`<li>${step}</li>`).join('');
 $('how-to').hidden=false;
}
async function boot(){try{const config=await api('/api/config');testRoles=config.testRoles;entryUrl=config.entryUrl||'';renderHowTo(config);$('registration-role-field').hidden=!testRoles;await load();}catch(e){$('login').hidden=false;$('login-error').textContent=e.message;}}
initWorkflow({$,esc,api,send,options,stages,roles,sources,toast,handle,load,showView,renderPipeline,openEditor,can,get me(){return me;},get leads(){return leads;},get users(){return users;}});
boot();


let paymentLead=null,paymentKey=crypto.randomUUID(),campaignDraft=null;
$('client-chat-tab').onclick=()=>chooseChat('client_bot');
const paymentNames={INITIATING:'Создаётся',INIT_UNKNOWN:'Результат запроса неизвестен',INIT_FAILED:'Не создан',NEW:'Ожидает оплаты',FORM_SHOWED:'Форма открыта',AUTHORIZING:'Авторизация',AUTHORIZED:'Средства заблокированы — ещё не оплачено',CONFIRMING:'Подтверждается',CONFIRMED:'Оплачено',REJECTED:'Отклонён',CANCELED:'Отменён',CANCELLED:'Отменён',REVERSED:'Отменён',DEADLINE_EXPIRED:'Срок истёк',REFUNDED:'Возврат',PARTIAL_REFUNDED:'Частичный возврат — требуется сверка'};
function renderCommerceStatus(){
 const client=integrations.clientBot,pay=integrations.payments;
 $('commerce-status').textContent=`Клиентский бот: ${client.state==='connected'?'подключён · клиенты оставляют заявки, команда получает уведомления':client.state==='disabled'?'не настроен':client.state==='connecting'?'подключается':'ошибка подключения'} · Т-Банк: ${pay.configured?'тестовый режим '+pay.mode:'ожидает настройки'}`;
 $('client-bot-link').hidden=!client.username;if(client.username)$('client-bot-link').href=`https://t.me/${encodeURIComponent(client.username)}`;
}
async function loadClientProfile(id){
 try{const data=await api(`/api/leads/${id}/client`);if(editing!==id)return;
 if(!data){$('client-profile').innerHTML='<p class="hint">Клиент ещё не подключился ко второму боту. Создайте персональную ссылку или попросите его открыть клиентского бота.</p>';return;}
 const u=data.profile;
 $('client-profile').innerHTML=`<div class="client-profile"><b>${esc([u.first_name,u.last_name].filter(Boolean).join(' '))}</b><dl><dt>Telegram ID</dt><dd>${esc(u.id)}</dd><dt>Юзернейм</dt><dd>${u.username?'@'+esc(u.username):'Не указан'}</dd><dt>Телефон</dt><dd>${esc(data.contact_profile?.phone_number??'Не передан клиентом')}</dd><dt>Язык / Premium</dt><dd>${esc(u.language_code??'—')} / ${u.is_premium?'Да':'Нет данных'}</dd><dt>Уведомления</dt><dd>${data.notifications_enabled&&!data.blocked?'Включены':'Отключены'}</dd><dt>Рассылки</dt><dd>${data.broadcast_enabled&&!data.blocked?'Подписан':'Не подписан'}</dd><dt>Первый вход</dt><dd>${date(data.first_seen)}</dd><dt>Последнее сообщение</dt><dd>${date(data.last_seen)}</dd></dl><details><summary>Все доступные данные Telegram</summary><pre>${esc(JSON.stringify({user:u,chat:data.chat_profile,contact:data.contact_profile,last_events:data.events},null,2))}</pre></details></div>`;
 }catch(e){if(editing===id)$('client-profile').textContent=e.message;}
}
async function paymentList(){
 const id=paymentLead,list=await api(`/api/leads/${id}/payments`);if(id!==paymentLead)return;
 $('payment-list').innerHTML=list.map(p=>`<article class="payment-card"><div class="commerce-head"><b>${money(p.amount/100)}</b><span class="badge ${p.status==='CONFIRMED'?'paid':''}">${esc(paymentNames[p.status]??p.status)}</span></div><p>${esc(p.description)}</p><small>Тестовый счёт · ${date(p.created_at)}<br>Заказ ${esc(p.order_id)}</small>${p.last_error?`<p class="error">${esc(p.last_error)}</p>`:''}${p.payment_url?`<a class="button" href="${esc(p.payment_url)}" target="_blank" rel="noopener">Открыть тестовую оплату ↗</a>`:''}<div class="dialog-actions">${can('leads:write')?`<button type="button" class="button" data-sync-payment="${p.id}">Проверить в банке</button>${['NEW','FORM_SHOWED'].includes(p.status)&&p.payment_url?`<button type="button" class="button" data-send-payment="${p.id}">Отправить ссылку ещё раз</button>`:''}`:''}</div><p class="hint">Ссылка в боте: ${{pending:'в очереди',sent:'отправлена',failed:'не доставлена',canceled:'отменена',client_not_connected:'клиент ещё не подключён',not_sent:'не отправлялась'}[p.delivery]??p.delivery}${p.remind_at?' · Напоминание '+date(p.remind_at):''}</p></article>`).join('')||'<p class="muted">Счетов пока нет.</p>';
}
async function openPayments(id){
 paymentLead=id;paymentKey=crypto.randomUUID();const lead=leads.find(l=>l.id===id);$('payment-form').reset();$('payment-error').textContent='';$('payment-amount').value=lead?.budget||100;$('payment-description').value=('Оплата услуг — '+(lead?.company||lead?.name||'агентство')).slice(0,140);$('payment-remind').value=localDate(Date.now()+86400000);
 $('receipt-field').hidden=!integrations.payments.receiptRequired;$('receipt-email').required=integrations.payments.receiptRequired;$('payment-form').hidden=!can('leads:write');$('create-payment').disabled=!integrations.payments.configured;
 $('payment-config').textContent=integrations.payments.configured?'Тестовый режим '+integrations.payments.mode+'. Оплата отмечается только после подтверждения банка.':'Интеграция пока не настроена: '+integrations.payments.issues.join(', ');
 $('payments-dialog').showModal();$('payment-list').textContent='Загрузка…';await paymentList();
}
$('lead-payment').onclick=handle(()=>openPayments(editing));
$('lead-invite').onclick=handle(async()=>{const data=await send(`/api/leads/${editing}/client-invite`,'POST',{});$('invite-url').value=data.url;$('invite-result').hidden=false;$('invite-url').select();});
$('lead-client-chat').onclick=()=>{const lead=leads.find(l=>l.id===editing);$('editor').close();chooseChat('client_bot',lead.client_chat_id);};
$('payment-form').addEventListener('input',()=>paymentKey=crypto.randomUUID());
$('payment-form').onsubmit=async e=>{
 e.preventDefault();$('create-payment').disabled=true;$('payment-error').textContent='';
 try{await send(`/api/leads/${paymentLead}/payments`,'POST',{amount:$('payment-amount').value,description:$('payment-description').value,remind_at:$('payment-remind').value?new Date($('payment-remind').value).toISOString():null,receipt_email:$('receipt-email').value,clientRequestId:paymentKey});await paymentList();toast('Результат создания счёта сохранён');}
 catch(err){$('payment-error').textContent=err.message;await paymentList();}finally{$('create-payment').disabled=!integrations.payments.configured;}
};
document.addEventListener('click',handle(async e=>{
 const sync=e.target.closest('[data-sync-payment]'),resend=e.target.closest('[data-send-payment]');if(!sync&&!resend)return;const button=sync||resend;button.disabled=true;$('payment-error').textContent='';
 try{await send(`/api/payments/${sync?sync.dataset.syncPayment:resend.dataset.sendPayment}/${sync?'sync':'send'}`,'POST',sync?{}:{clientRequestId:crypto.randomUUID()});await paymentList();await load();if(editing===paymentLead){const lead=leads.find(l=>l.id===editing);$('lead-paid-badge').textContent=lead.paid?'Оплачено '+money(lead.paid_amount/100):'Не оплачено';}toast(sync?'Статус проверен':'Ссылка в очереди отправки');}catch(err){$('payment-error').textContent=err.message;}finally{button.disabled=false;}
}));
function resetCampaignPreview(){campaignDraft=null;$('broadcast-send').hidden=true;$('broadcast-preview-result').textContent='';}
async function campaignHistory(){const list=await api('/api/campaigns');$('broadcast-history').innerHTML=list.map(c=>`<article class="payment-card"><p>${esc(c.body)}</p><small>${date(c.sent_at)} · ${c.delivery.map(d=>`${{sent:'Отправлено',pending:'В очереди',failed:'Ошибка',canceled:'Отменено'}[d.delivery]??d.delivery}: ${d.count}`).join(' · ')||'Нет получателей'}</small></article>`).join('')||'<p class="hint">Рассылок пока нет.</p>';}
$('broadcast-button').onclick=handle(async()=>{resetCampaignPreview();$('broadcast-body').value='';$('broadcast-error').textContent='';$('broadcast-tag').innerHTML='<option value="">Все подписавшиеся</option>'+[...new Set(leads.flatMap(l=>l.tags))].sort().map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');$('broadcast-dialog').showModal();await campaignHistory();});
$('broadcast-body').oninput=resetCampaignPreview;$('broadcast-tag').onchange=resetCampaignPreview;
$('broadcast-preview').onclick=async()=>{
 $('broadcast-preview').disabled=true;$('broadcast-error').textContent='';
 try{const draft=await send('/api/campaigns/preview','POST',{body:$('broadcast-body').value,tag:$('broadcast-tag').value||null});campaignDraft=draft;$('broadcast-preview-result').innerHTML=`<p><b>Получателей: ${draft.count}</b></p><p>${draft.recipients.map(r=>esc(r.name)).join(', ')||'Нет подписавшихся клиентов'}</p>`;$('broadcast-send').textContent=`Подтвердить отправку: ${draft.count}`;$('broadcast-send').hidden=!draft.count;}
 catch(err){$('broadcast-error').textContent=err.message;}finally{$('broadcast-preview').disabled=false;}
};
$('broadcast-send').onclick=async()=>{
 if(!campaignDraft)return;$('broadcast-send').disabled=true;$('broadcast-error').textContent='';
 try{const result=await send(`/api/campaigns/${campaignDraft.id}/send`,'POST',{});toast(result.alreadySent?'Эта рассылка уже отправлена':`В очереди: ${result.queued}`);resetCampaignPreview();await campaignHistory();}
 catch(err){$('broadcast-error').textContent=err.message;}finally{$('broadcast-send').disabled=false;}
};
