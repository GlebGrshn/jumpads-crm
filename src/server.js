import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore,validateLead } from './store.js';
import { startBot } from './bot.js';
import { permissions,fail,hash } from './crm.js';
import { createPaymentService,paymentConfig } from './payments.js';
import { createAutomationService } from './automations.js';
import { randomUUID } from 'node:crypto';
import { acceptClientUpdate,clientDetails,createInvite,notifyStage,notifyClient,campaignPreview,sendCampaign } from './client-bot.js';

export function createApp({store,production=false,testRoles=!production,trustProxy=false,entryUrl='',requireTelegram=true,botStatus={state:'disabled'},clientBotStatus={state:'disabled'},paymentsConfig=paymentConfig({}),bankTransport=null}) {
 const payments=createPaymentService(store,paymentsConfig,bankTransport);
 const automation=createAutomationService(store);
 const attempts=new Map();
 const tokenOf=req=>/(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie??'')?.[1]??'';
 // Behind a tunnel or reverse proxy every request arrives from the proxy itself; only then trust its forwarded headers.
 const clientIp=req=>trustProxy&&req.headers['x-forwarded-for']?req.headers['x-forwarded-for'].split(',')[0].trim():req.socket.remoteAddress;
 const publicHost=req=>trustProxy&&req.headers['x-forwarded-host']?req.headers['x-forwarded-host'].split(',')[0].trim():req.headers.host;
 const originHost=value=>{try{return new URL(value).host;}catch{return null;}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control','no-store');
  const json=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  try {
   const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
   if(path==='/health'&&method==='GET')return json(200,{ok:true,bots:{team:botStatus.state,client:clientBotStatus.state}});
   if(!['GET','HEAD'].includes(method)){
    if(path!=='/webhooks/tbank'&&(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&originHost(req.headers.origin)!==publicHost(req))))throw fail(403,'Запрос с другого сайта запрещён');
    if(!(req.headers['content-type']??'').startsWith('application/json'))throw fail(415,'Ожидается JSON');
   }
   async function body(){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>65536)throw fail(413,'Слишком большой запрос');chunks.push(chunk);}try{const data=JSON.parse(Buffer.concat(chunks).toString());if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}catch{throw fail(400,'Некорректный JSON');}}
   const cookie=value=>res.setHeader('Set-Cookie',`session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?43200:0}${production?'; Secure':''}`);
   if(path==='/webhooks/tbank'&&method==='POST'){payments.webhook(await body());res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end('OK');}
   if(path==='/api/config'&&method==='GET')return json(200,{testRoles,registration:true,entryUrl,bots:{client:clientBotStatus.username??null,team:botStatus.username??null}});
   if(['/api/login','/api/register'].includes(path)&&method==='POST'){
    const now=Date.now(),ip=clientIp(req);
    for(const [key,v] of attempts)if(v.until<now)attempts.delete(key);
    const attempt=attempts.get(ip)??{count:0,until:now+60000};
    if(attempt.count>=15)throw fail(429,'Слишком много попыток. Подождите минуту.');attempt.count++;attempts.set(ip,attempt);
    const input=await body();const user=path==='/api/register'?await store.register(input,testRoles,{requireTelegram}):await store.login(input);
    cookie(store.session(user));return json(path==='/api/register'?201:200,{user,testRoles,permissions:permissions[user.role]});
   }
   if(path.startsWith('/api/')){
    const user=store.authenticate(tokenOf(req));if(!user)throw fail(401,'Войдите в CRM');
    const permit=permission=>{if(!permissions[user.role].includes(permission))throw fail(403,'Недостаточно прав для этого действия');};
    const match=pattern=>pattern.exec(path);
    if(path==='/api/automations'&&method==='GET'){permit('users:roles');return json(200,{rules:automation.list(),runs:automation.runs()});}
    if(path==='/api/automations/preview'&&method==='POST'){permit('users:roles');const input=await body();return json(200,automation.preview(input.rule,input.lead_id));}
    const autoRule=match(/^\/api\/automations\/([a-f0-9-]+)$/);
    if((path==='/api/automations'&&method==='POST')||(autoRule&&method==='PUT')){permit('users:roles');return json(200,automation.save(await body(),user,autoRule?.[1]));}
    const autoRun=match(/^\/api\/automations\/([a-f0-9-]+)\/run$/);
    if(autoRun&&method==='POST'){permit('users:roles');const input=await body();return json(201,automation.manual(autoRun[1],input.lead_id,input.clientRequestId));}
    const autoCancel=match(/^\/api\/automation-runs\/([a-f0-9-]+)\/cancel$/);
    if(autoCancel&&method==='POST'){permit('users:roles');automation.cancel(autoCancel[1]);return json(200,{ok:true});}
    if(path==='/api/kanban-views'&&method==='GET')return json(200,store.db.prepare('SELECT id,name,filters FROM kanban_views WHERE user_id=? ORDER BY rowid').all(user.id).map(v=>({...v,filters:JSON.parse(v.filters)})));
    if(path==='/api/kanban-views'&&method==='POST'){
     const input=await body();if(typeof input.name!=='string'||!input.name.trim()||input.name.length>60||!input.filters||typeof input.filters!=='object'||Array.isArray(input.filters))throw fail(400,'Название до 60 символов и набор фильтров обязательны');
     const filters={};for(const key of ['q','source','status','owner','tag','paid','min','max','from','to','archive']){const value=input.filters[key]??'';if(typeof value!=='string'||value.length>200)throw fail(400,'Некорректный фильтр');filters[key]=value;}
     const count=store.db.prepare('SELECT count(*) AS n FROM kanban_views WHERE user_id=?').get(user.id).n;if(count>=30)throw fail(400,'Можно сохранить до 30 фильтров');
     const id=randomUUID();store.db.prepare('INSERT INTO kanban_views VALUES(?,?,?,?)').run(id,user.id,input.name.trim(),JSON.stringify(filters));return json(201,{id,name:input.name.trim(),filters});
    }
    const savedView=match(/^\/api\/kanban-views\/([a-f0-9-]+)$/);
    if(savedView&&method==='DELETE'){store.db.prepare('DELETE FROM kanban_views WHERE id=? AND user_id=?').run(savedView[1],user.id);return json(200,{ok:true});}
    if(path==='/api/me'&&method==='GET')return json(200,{user,testRoles,permissions:permissions[user.role]});
    if(path==='/api/me/telegram'&&method==='PATCH'){const input=await body();return json(200,{user:store.setTelegram(user.id,input.telegram),botUsername:botStatus.username??null});}
    if(path==='/api/me/telegram-link'&&method==='POST'){
     if(!botStatus.username)throw fail(409,'Бот команды ещё не подключён');
     return json(201,{url:`https://t.me/${botStatus.username}?start=staff_${store.staffLink(user.id)}`,expires_in_hours:24});
    }
    if(path==='/api/me/role'&&method==='PATCH'){
     if(!testRoles)throw fail(403,'Свободный выбор роли выключен');const input=await body();const changed=store.setRole(user.id,input.role);return json(200,{user:changed,permissions:permissions[changed.role],testRoles});
    }
    if(path==='/api/logout'&&method==='POST'){store.logout(tokenOf(req));cookie('');return json(200,{ok:true});}
    if(path==='/api/users'&&method==='GET')return json(200,store.users());
    const userRoute=match(/^\/api\/users\/([a-f0-9-]+)\/role$/);
    if(userRoute&&method==='PATCH'){
     permit('users:roles');const input=await body();
     const target=store.user(userRoute[1]);if(!target)throw fail(404,'Пользователь не найден');
     if(!testRoles&&target.role==='admin'&&input.role!=='admin'&&store.users().filter(u=>u.role==='admin').length===1)throw fail(409,'Нельзя убрать последнего администратора');
     return json(200,store.setRole(target.id,input.role));
    }
    if(path==='/api/status'&&method==='GET')return json(200,botStatus);
    if(path==='/api/integrations'&&method==='GET')return json(200,{clientBot:clientBotStatus,payments:payments.status()});
    const clientRoute=match(/^\/api\/leads\/([a-f0-9-]+)\/client$/);
    if(clientRoute&&method==='GET')return json(200,clientDetails(store,clientRoute[1]));
    const inviteRoute=match(/^\/api\/leads\/([a-f0-9-]+)\/client-invite$/);
    if(inviteRoute&&method==='POST'){permit('leads:write');return json(201,createInvite(store,inviteRoute[1],clientBotStatus.username));}
    const paymentListRoute=match(/^\/api\/leads\/([a-f0-9-]+)\/payments$/);
    if(paymentListRoute&&method==='GET')return json(200,payments.list(paymentListRoute[1]).map(p=>({...p,delivery:payments.delivery(p.id)})));
    if(paymentListRoute&&method==='POST'){permit('leads:write');return json(201,await payments.create(paymentListRoute[1],await body(),user));}
    const paymentSyncRoute=match(/^\/api\/payments\/([a-f0-9-]+)\/sync$/);
    if(paymentSyncRoute&&method==='POST'){permit('leads:write');return json(200,await payments.sync(paymentSyncRoute[1]));}
    const resendRoute=match(/^\/api\/payments\/([a-f0-9-]+)\/send$/);
    if(resendRoute&&method==='POST'){
     permit('leads:write');const p=payments.get(resendRoute[1]);if(!p||!p.payment_url)throw fail(404,'Ссылка оплаты не найдена');
     if(!['NEW','FORM_SHOWED'].includes(p.status))throw fail(409,'Этот счёт уже не ожидает оплаты');if(clientBotStatus.state==='disabled')throw fail(409,'Подключите клиентского бота');
     const input=await body();if(typeof input.clientRequestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.clientRequestId))throw fail(400,'Нужен ключ отправки');
     const m=notifyClient(store,p.lead_id,`Счёт: ${p.description}\nСумма: ${(p.amount/100).toFixed(2)} ₽\nТестовая оплата: ${p.payment_url}`,`invoice-resend:${p.id}:${user.id}:${input.clientRequestId}`);
     if(!m)throw fail(409,'Клиент не подключён или отключил уведомления');return json(200,m);
    }
    if(path==='/api/campaigns/preview'&&method==='POST'){permit('users:roles');return json(201,campaignPreview(store,user,await body()));}
    const campaignRoute=match(/^\/api\/campaigns\/([a-f0-9-]+)\/send$/);
    if(campaignRoute&&method==='POST'){permit('users:roles');if(clientBotStatus.state==='disabled')throw fail(409,'Подключите клиентского бота');return json(200,sendCampaign(store,user,campaignRoute[1]));}
    if(path==='/api/campaigns'&&method==='GET'){
     permit('users:roles');return json(200,store.db.prepare("SELECT id,body,tag,state,created_at,sent_at FROM campaigns WHERE state='sent' ORDER BY created_at DESC LIMIT 20").all().map(c=>({...c,delivery:store.db.prepare('SELECT delivery,count(*) AS count FROM messages WHERE client_key LIKE ? GROUP BY delivery').all(`campaign:${c.id}:%`)})));
    }
    if(path==='/api/leads'&&method==='GET'){
     const q=(url.searchParams.get('q')??'').toLowerCase(),tag=url.searchParams.get('tag'),status=url.searchParams.get('status');
     return json(200,store.list().filter(l=>(!tag||l.tags.includes(tag))&&(!status||l.status===status)&&`${l.name} ${l.contact} ${l.request} ${l.company}`.toLowerCase().includes(q)));
    }
    const leadRoute=match(/^\/api\/leads\/([a-f0-9-]+)$/);
    if((path==='/api/leads'&&method==='POST')||(leadRoute&&method==='PATCH')){
     permit('leads:write');const input=await body();const old=leadRoute?store.get(leadRoute[1]):null;if(leadRoute&&!old)throw fail(404,'Лид не найден');
     let data;try{data=validateLead({...old,...input});}catch(e){throw fail(400,e.message);}
     if(data.status==='paid'&&!old?.paid)throw fail(409,'Этап «Оплачено» доступен только после подтверждения банка');
     if(data.owner_id&&!store.user(data.owner_id))throw fail(400,'Ответственный не найден');
     if(typeof input.clientRequestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.clientRequestId))throw fail(400,'Нужен ключ операции clientRequestId');
     const key=`${user.id}:${input.clientRequestId}`,fingerprint=hash(JSON.stringify({id:old?.id??null,data}));
     return store.transaction(()=>{
      const cached=store.db.prepare('SELECT * FROM mutations WHERE key=?').get(key);
      if(cached){if(cached.fingerprint!==fingerprint)throw fail(409,'Ключ операции уже использован для других данных');return json(200,JSON.parse(cached.result));}
      const duplicates=store.duplicates(data,old?.id);
      // An unchanged contact on an already accepted duplicate does not need another confirmation.
      const changedIdentity=!old||old.contact!==data.contact||old.name!==data.name||old.request!==data.request;
      if(duplicates.length&&changedIdentity&&input.confirmDuplicate!==true)throw fail(409,'Уверены ли вы, что хотите продублировать существующий лид?',{code:'DUPLICATE_LEAD',duplicates:duplicates.map(l=>({id:l.id,name:l.name,contact:l.contact,archived:l.archived}))});
      const saved=old?store.update(old.id,data,user.id):store.create(data,'manual',user.id);
      store.activity(saved.id,user.username,old?'Обновлена карточка лида':input.confirmDuplicate?'Создан лид: дубль подтверждён':'Создан лид');
      if(old&&old.status!==saved.status)notifyStage(store,saved.id,saved.status,`stage:${key}`);
      store.db.prepare('INSERT INTO mutations VALUES (?,?,?)').run(key,fingerprint,JSON.stringify(saved));
      return json(old?200:201,saved);
     });
    }
    const archiveRoute=match(/^\/api\/leads\/([a-f0-9-]+)\/archive$/);
    if(archiveRoute&&method==='PATCH'){
     permit('leads:archive');const input=await body();if(!store.get(archiveRoute[1]))throw fail(404,'Лид не найден');if(typeof input.archived!=='boolean')throw fail(400,'Ожидается archived: true/false');
     store.db.prepare('UPDATE leads SET archived=? WHERE id=?').run(Number(input.archived),archiveRoute[1]);store.activity(archiveRoute[1],user.username,input.archived?'Лид архивирован':'Лид восстановлен');return json(200,store.get(archiveRoute[1]));
    }
    const historyRoute=match(/^\/api\/leads\/([a-f0-9-]+)\/history$/);
    if(historyRoute&&method==='GET')return json(200,store.history(historyRoute[1]));
    if(path==='/api/tasks'&&method==='GET')return json(200,store.tasks());
    const taskRoute=match(/^\/api\/tasks\/([a-f0-9-]+)$/);
    if((path==='/api/tasks'&&method==='POST')||(taskRoute&&method==='PATCH')){
     permit('tasks:write');const input=await body();const task=store.saveTask(input,user,taskRoute?.[1]);store.tick();return json(taskRoute?200:201,task);
    }
    if(path==='/api/notifications'&&method==='GET'){store.tick();return json(200,store.notifications(user.id));}
    const notificationRoute=match(/^\/api\/notifications\/([a-f0-9-]+)\/read$/);
    if(notificationRoute&&method==='POST'){
     store.db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(new Date().toISOString(),notificationRoute[1],user.id);return json(200,{ok:true});
    }
    if(path==='/api/conversations'&&method==='GET'){const kind=url.searchParams.get('kind')??'telegram';if(!['telegram','client_bot'].includes(kind))throw fail(400,'Неизвестный бот');return json(200,store.conversations(kind));}
    if(path==='/api/messages'&&method==='GET'){
     const kind=url.searchParams.get('kind')??'team';if(!['team','telegram','client_bot'].includes(kind))throw fail(400,'Неизвестный чат');return json(200,store.messages(user,kind,url.searchParams.get('target')));
    }
    if(path==='/api/messages'&&method==='POST'){
     permit('chat:write');const input=await body();if(!['team','telegram','client_bot'].includes(input.kind))throw fail(400,'Неизвестный чат');
     if(typeof input.clientRequestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.clientRequestId))throw fail(400,'Нужен ключ сообщения');
     const key=`message:${user.id}:${input.clientRequestId}`;
     if(['telegram','client_bot'].includes(input.kind)){
      if((input.kind==='client_bot'?clientBotStatus:botStatus).state==='disabled')throw fail(409,'Сначала подключите выбранного Telegram-бота');
      if(typeof input.target!=='string'||!store.conversations(input.kind).some(c=>c.chat_id===input.target))throw fail(404,'Диалог Telegram не найден');
      return json(201,store.queueReply(input.target,input.body,user.username,user.id,key,input.kind));
     }
     if(input.target&&!store.user(input.target))throw fail(404,'Собеседник не найден');
     return json(201,store.addMessage({kind:'team',sender_id:user.id,recipient_id:input.target||null,author:user.username,body:input.body,client_key:key}));
    }
    throw fail(404,'Не найдено');
   }
   const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/workflow.js':['workflow.js','text/javascript'],'/theme.js':['theme.js','text/javascript'],'/style.css':['style.css','text/css'],'/payment/result':['payment-result.html','text/html']};
   if(method==='GET'&&files[path]){const [file,type]=files[path];const content=await readFile(new URL(`../public/${file}`,import.meta.url));res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});return res.end(content);}
   throw fail(404,'Не найдено');
  }catch(e){if(!res.headersSent)json(e.status??500,{error:e.status?e.message:'Ошибка сервера. Попробуйте ещё раз.',...(e.code==='DUPLICATE_LEAD'?{code:e.code,duplicates:e.duplicates}:{})});else res.end();}
 });
 const reminderTimer=setInterval(()=>{try{store.tick();payments.tick();}catch(e){console.error('Reminder tick failed:',e.message);}},15000);reminderTimer.unref();server.on('close',()=>clearInterval(reminderTimer));
 const paymentTimer=setInterval(()=>{payments.pollPending().catch(e=>console.error('Payment status poll failed:',e.message));},60000);paymentTimer.unref();server.on('close',()=>clearInterval(paymentTimer));
 const automationTimer=setInterval(()=>{try{automation.tick();}catch(e){console.error('Automation tick failed:',e.message);}},1000);automationTimer.unref();server.on('close',()=>clearInterval(automationTimer));
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const store=openStore(process.env.DB_PATH??'./data/crm.sqlite'),token=process.env.TELEGRAM_BOT_TOKEN;
 const status={state:token?'connecting':'disabled',username:null,lastSync:null};
 const clientToken=process.env.CLIENT_TELEGRAM_BOT_TOKEN;
 const clientStatus={state:clientToken?'connecting':'disabled',username:process.env.CLIENT_BOT_USERNAME?.replace(/^@/,'')||null,lastSync:null};
 if(clientToken&&clientToken===token)throw new Error('Use separate tokens for the two bots');
 const production=process.env.NODE_ENV==='production';
 const testRoles=process.env.TEST_ROLE_SELECTION===undefined?!production:process.env.TEST_ROLE_SELECTION==='true';
 const server=createApp({store,production,testRoles,trustProxy:process.env.TRUST_PROXY==='true',entryUrl:process.env.PUBLIC_ENTRY_URL??'',botStatus:status,clientBotStatus:clientStatus,paymentsConfig:paymentConfig()});let stopBot=async()=>{},stopClientBot=async()=>{};
 server.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1',()=>{console.log(`CRM listening on port ${server.address().port}; test roles: ${testRoles}`);if(token)stopBot=startBot(store,token,status,{context:{clientBot:clientStatus}});if(clientToken)stopClientBot=startBot(store,clientToken,clientStatus,{kind:'client_bot',offsetKey:'client_offset',accept:acceptClientUpdate,allowedUpdates:['message','my_chat_member']});});
 const stop=async()=>{server.close();await Promise.all([stopBot(),stopClientBot()]);server.closeAllConnections();store.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
