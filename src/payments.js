import { createHash,timingSafeEqual,randomUUID } from 'node:crypto';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fail } from './crm.js';
import { notifyClient,clientMember } from './client-bot.js';
export function bankToken(payload,password){
 const values={...payload,Password:password};delete values.Token;
 const text=Object.keys(values).filter(k=>values[k]!==null&&values[k]!==undefined&&typeof values[k]!=='object').sort().map(k=>String(values[k])).join('');
 return createHash('sha256').update(text,'utf8').digest('hex');
}
// T-Bank serves certificates of the Russian national CA (Минцифры). Trust it for bank requests only, not process-wide.
const bankAgent=new https.Agent({keepAlive:true,ca:(()=>{try{return [...rootCertificates,readFileSync(new URL('../certs/russian_trusted_root_ca.pem',import.meta.url),'utf8')];}catch{return undefined;}})()});
// notSent: the failure happened before the TLS connection was up, so the bank cannot have received the request.
function postJson(url,body){
 return new Promise((resolve,reject)=>{
  let connected=false;
  const req=https.request(url,{method:'POST',agent:bankAgent,headers:{'Content-Type':'application/json'}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});
   res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error('Transport'));try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });
  req.on('socket',socket=>{if(!socket.connecting)connected=true;else socket.once('secureConnect',()=>{connected=true;});});
  req.setTimeout(20000,()=>req.destroy(new Error('timeout')));
  req.on('error',e=>reject(Object.assign(e,{notSent:!connected})));
  req.end(JSON.stringify(body));
 });
}
export function paymentConfig(env=process.env){return {terminalKey:env.TBANK_TERMINAL_KEY??'',password:env.TBANK_PASSWORD??'',mode:env.TBANK_MODE??'demo',publicUrl:env.APP_PUBLIC_URL??'',taxation:env.TBANK_RECEIPT_TAXATION??'',tax:env.TBANK_RECEIPT_TAX??''};}
const unpaid=['INITIATING','INIT_UNKNOWN','NEW','FORM_SHOWED','AUTHORIZING','3DS_CHECKING','3DS_CHECKED','AUTHORIZED','CONFIRMING'];
const refunds=['REFUNDED','PARTIAL_REFUNDED'];
const known=new Set([...unpaid,'CONFIRMED','REJECTED','CANCELED','CANCELLED','REVERSING','REFUNDING','REVERSED','PARTIAL_REVERSED','DEADLINE_EXPIRED','AUTH_FAIL',...refunds]);
const rank={NEW:1,FORM_SHOWED:2,AUTHORIZING:3,'3DS_CHECKING':4,'3DS_CHECKED':5,AUTHORIZED:6,CONFIRMING:7,CONFIRMED:8};
const requestKey=v=>{if(typeof v!=='string'||!(/^[a-zA-Z0-9-]{8,80}$/).test(v))throw fail(400,'Нужен ключ операции');return v;};
// Current DEMO Init responses also use this exact hosted checkout domain.
// Keep the extra host narrow: arbitrary tbank-online.com subdomains are not trusted.
const validUrl=value=>{try{if(typeof value!=='string'||value.length>4096)return false;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='pay.tbank-online.com'||['tbank.ru','tinkoff.ru'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host)));}catch{return false;}};
export function createPaymentService(store,config=paymentConfig({}),transport=null){
 const db=store.db,inflight=new Map();
 // Behind a tunnel the public address changes: without APP_PUBLIC_URL the tunnel watchdog keeps the current one in meta.
 const publicUrl=()=>config.publicUrl||db.prepare("SELECT value FROM meta WHERE key='public_url'").get()?.value||'';
 const configIssues=()=>{
  const issues=[];if(!config.terminalKey)issues.push('TBANK_TERMINAL_KEY');if(!config.password)issues.push('TBANK_PASSWORD');
  if(!['demo','sandbox'].includes(config.mode))issues.push('TBANK_MODE: только demo или sandbox');
  if(config.mode==='demo'&&config.terminalKey&&!config.terminalKey.endsWith('DEMO'))issues.push('Для demo нужен тестовый терминал с суффиксом DEMO');
  if(config.mode==='sandbox'&&config.terminalKey.endsWith('DEMO'))issues.push('Для sandbox нужен терминал без DEMO');
  try{const u=new URL(publicUrl());if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error();}catch{issues.push('APP_PUBLIC_URL: публичный HTTPS-адрес без пути');}
  if(Boolean(config.taxation)!==Boolean(config.tax))issues.push('Укажите вместе TBANK_RECEIPT_TAXATION и TBANK_RECEIPT_TAX');
  if(config.taxation&&!['osn','usn_income','usn_income_outcome','esn','patent'].includes(config.taxation))issues.push('Некорректная система налогообложения');
  if(config.tax&&!['none','vat0','vat5','vat7','vat10','vat22','vat105','vat107','vat110','vat122'].includes(config.tax))issues.push('Некорректная ставка НДС');
  return issues;
 };
 const requireConfig=()=>{const issues=configIssues();if(issues.length)throw fail(409,'Настройте интеграцию: '+issues.join(', '));};
 const get=id=>db.prepare('SELECT * FROM payments WHERE id=?').get(id);
 const list=leadId=>db.prepare('SELECT * FROM payments WHERE lead_id=? ORDER BY created_at DESC,rowid DESC').all(leadId);
 const endpoint=()=>config.mode==='sandbox'?'https://rest-api-test.tinkoff.ru/v2/':'https://securepay.tinkoff.ru/v2/';
 async function call(method,params){
  const payload={TerminalKey:config.terminalKey,...params};payload.Token=bankToken(payload,config.password);
  let data;
  try{data=transport?await transport(method,payload):await postJson(endpoint()+method,payload);}
  catch(e){
   // No connection (VPN, blocked route, untrusted certificate) means the bank never saw it: the invoice may be created again.
   if(e.notSent)throw fail(502,`Т-Банк недоступен: соединение не установлено${e.code?` (${e.code})`:''}, счёт не создан. Повторите позже.`,{bankRejected:true});
   throw fail(502,'Ответ банка не получен. Статус операции пока неизвестен; повторный счёт автоматически не создаётся.');
  }
  if(!data||data.Success!==true||String(data.ErrorCode??'0')!=='0')throw fail(502,`Т-Банк отклонил запрос (код ${String(data?.ErrorCode??'unknown').slice(0,20)}).`,{bankRejected:true});
  return data;
 }
 function applyState(p,data,origin){
  const status=data.Status;
  if(data.TerminalKey!==p.terminal_key||String(data.OrderId)!==p.order_id||!/^\d{1,20}$/.test(String(data.PaymentId))||(p.bank_payment_id&&String(data.PaymentId)!==p.bank_payment_id))throw fail(400,'Платёж не соответствует заказу');
  // GetState reports Amount=0 after canceling a NEW invoice. This exception is
  // only for cancellation; a successful payment must still match the full sum.
  const canceledZero=['CANCELED','CANCELLED'].includes(status)&&data.Amount===0;
  if(!Number.isSafeInteger(data.Amount)||(!refunds.includes(status)&&!canceledZero&&data.Amount!==p.amount)||(refunds.includes(status)&&(data.Amount<0||data.Amount>p.amount)))throw fail(400,'Сумма платежа не соответствует счёту');
  if(!known.has(status))throw fail(400,'Неизвестный статус платежа');
  if(status==='CONFIRMED'&&(data.Success!==true||String(data.ErrorCode??'0')!=='0'))throw fail(400,'Оплата не подтверждена');
  return store.transaction(()=>{
   p=get(p.id);
   if(p.status===status)return p;
   // Ignore delayed authorization/checkout notifications after capture/refund.
   if(refunds.includes(p.status)&&!refunds.includes(status))return p;
   if(p.status==='REFUNDED'&&status==='PARTIAL_REFUNDED')return p;
   if(p.status==='CONFIRMED'&&!refunds.includes(status))return p;
   if((rank[p.status]??0)>(rank[status]??99))return p;
   const now=new Date().toISOString();
   db.prepare('UPDATE payments SET status=?,bank_payment_id=?,paid_at=CASE WHEN ?=\'CONFIRMED\' THEN COALESCE(paid_at,?) ELSE paid_at END,updated_at=?,last_error=NULL WHERE id=?').run(status,String(data.PaymentId),status,now,now,p.id);
   db.prepare('INSERT INTO payment_events(payment_id,status,origin,created_at) VALUES (?,?,?,?)').run(p.id,status,origin,now);
   if(status==='CONFIRMED'||refunds.includes(status)){
    const sum=db.prepare("SELECT COALESCE(sum(amount),0) AS amount FROM payments WHERE lead_id=? AND status='CONFIRMED'").get(p.lead_id).amount;
    const lead=store.get(p.lead_id),isPaid=sum>0;
    db.prepare('UPDATE leads SET paid=?,paid_amount=?,paid_at=?,status=? WHERE id=?').run(Number(isPaid),sum,isPaid?(lead.paid_at??now):null,isPaid?'paid':lead.status==='paid'?'proposal':lead.status,p.lead_id);
    store.activity(p.lead_id,'Т-Банк',status==='CONFIRMED'?`Подтверждена тестовая оплата ${(p.amount/100).toFixed(2)} ₽. Этап: Оплачено.`:`Статус оплаты: ${status}. Сумма оплаченных счетов пересчитана.`);
    if(status==='CONFIRMED'){const notice=`💰 Оплата подтверждена: ${lead.name} — ${(p.amount/100).toFixed(2)} ₽\n${p.description}`,markup={inline_keyboard:[[{text:'Открыть',callback_data:`ld:${lead.id}`}]]};if(lead.owner_id)store.notifyUsers([lead.owner_id],notice,markup);else store.notifyTeam(notice,markup);}
    notifyClient(store,p.lead_id,status==='CONFIRMED'?`Тестовая оплата получена: ${(p.amount/100).toFixed(2)} ₽.\n${p.description}\nСтатус заявки: Оплачено.`:`Статус платежа изменён: ${status}. По вопросам обратитесь к менеджеру.`,`payment:${p.id}:${status}`);
   }
   return get(p.id);
  });
 }
 async function sync(id){
  requireConfig();const p=get(id);if(!p)throw fail(404,'Счёт не найден');if(p.mode!==config.mode||p.terminal_key!==config.terminalKey)throw fail(409,'Счёт относится к другой настройке терминала');
  if(!p.bank_payment_id)throw fail(409,'Банк ещё не вернул PaymentId. Не создавайте дубль: проверьте заказ '+p.order_id+' в кабинете Т-Банка; подписанное уведомление восстановит связь автоматически.');
  const data=await call('GetState',{PaymentId:p.bank_payment_id});return applyState(p,data,'GetState');
 }
 async function create(leadId,input,user){
  requireConfig();const lead=store.get(leadId);if(!lead)throw fail(404,'Лид не найден');if(lead.archived)throw fail(409,'Сначала восстановите лид из архива');
  const rubles=typeof input.amount==='string'?input.amount.trim().replace(',','.'):String(input.amount??'');if(!/^\d{1,7}(\.\d{1,2})?$/.test(rubles))throw fail(400,'Сумма: положительное число рублей, не более двух знаков после запятой');
  const [whole,fraction='']=rubles.split('.'),amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(amount<100||amount>100000000)throw fail(400,'Тестовый счёт: от 1 до 1 000 000 ₽');
  const description=typeof input.description==='string'?input.description.trim():'';if(!description||description.length>140)throw fail(400,'Описание: от 1 до 140 символов');
  const remindAt=input.remind_at?new Date(input.remind_at):null;if(remindAt&&!Number.isFinite(remindAt.getTime()))throw fail(400,'Неверное время напоминания');
  const key=`${user.id}:${requestKey(input.clientRequestId)}`;
  const old=db.prepare('SELECT * FROM payments WHERE request_key=?').get(key);
  if(old){if(old.lead_id!==leadId||old.amount!==amount||old.description!==description)throw fail(409,'Ключ операции уже использован');return inflight.get(key)??old;}
  if(list(leadId).some(p=>unpaid.includes(p.status)))throw fail(409,'У лида уже есть незавершённый счёт. Проверьте его статус; новый счёт не создан.');
  let receipt;
  if(config.taxation){const email=input.receipt_email;if(typeof email!=='string'||email.length>100||!/^\S+@\S+\.\S+$/.test(email))throw fail(400,'Укажите email для чека');receipt={Email:email,Taxation:config.taxation,Items:[{Name:description.slice(0,128),Price:amount,Quantity:1,Amount:amount,Tax:config.tax,PaymentMethod:'full_payment',PaymentObject:'service'}]};}
  const id=randomUUID(),orderId=id.replaceAll('-',''),now=new Date().toISOString();
  db.prepare('INSERT INTO payments(id,lead_id,order_id,terminal_key,mode,amount,description,status,created_at,updated_at,created_by,request_key,remind_at) VALUES (?,?,?,?,?,?,?,\'INITIATING\',?,?,?,?,?)').run(id,leadId,orderId,config.terminalKey,config.mode,amount,description,now,now,user.id,key,remindAt?.toISOString()??null);
  const pending=(async()=>{
   try{
    const base=publicUrl().replace(/\/$/,'');
    const data=await call('Init',{Amount:amount,OrderId:orderId,Description:description,PayType:'O',Language:'ru',NotificationURL:base+'/webhooks/tbank',SuccessURL:base+'/payment/result',FailURL:base+'/payment/result',...(receipt?{Receipt:receipt}:{})});
    applyState(get(id),data,'Init');
    // A rejected checkout link does not mean Init is unknown. Retain the verified
    // bank identity/status so GetState and signed callbacks can still reconcile it.
    if(!validUrl(data.PaymentURL)){
     const message='Банк создал счёт, но ссылка оплаты отсутствует или её адрес не разрешён. Статус можно проверить в банке; новый счёт не создан.';
     db.prepare('UPDATE payments SET last_error=?,updated_at=? WHERE id=?').run(message,new Date().toISOString(),id);
     throw fail(502,message);
    }
    return store.transaction(()=>{
     db.prepare('UPDATE payments SET payment_url=?,updated_at=? WHERE id=?').run(data.PaymentURL,new Date().toISOString(),id);
     store.activity(leadId,user.username,`Выставлен тестовый счёт ${(amount/100).toFixed(2)} ₽`);
     const current=get(id);if(unpaid.includes(current.status))notifyClient(store,leadId,`Счёт: ${description}\nСумма: ${(amount/100).toFixed(2)} ₽\nТестовая оплата: ${data.PaymentURL}`,`invoice:${id}`);
     return current;
    });
   }catch(e){const current=get(id);if(current.status==='INITIATING')db.prepare('UPDATE payments SET status=?,last_error=?,updated_at=? WHERE id=?').run(e.bankRejected?'INIT_FAILED':'INIT_UNKNOWN',e.message,new Date().toISOString(),id);throw e;}
   finally{inflight.delete(key);}
  })();inflight.set(key,pending);return pending;
 }
 function webhook(data){
  requireConfig();if(typeof data.Token!=='string'||!/^[a-fA-F0-9]{64}$/.test(data.Token))throw fail(403,'Неверная подпись');
  if(!timingSafeEqual(Buffer.from(data.Token.toLowerCase()),Buffer.from(bankToken(data,config.password))))throw fail(403,'Неверная подпись');
  const p=db.prepare('SELECT * FROM payments WHERE order_id=?').get(String(data.OrderId));if(!p)throw fail(404,'Счёт не найден');if(p.terminal_key!==config.terminalKey||p.mode!==config.mode)throw fail(403,'Другой терминал');
  return applyState(p,data,'webhook');
 }
 function tick(now=new Date().toISOString()){
  store.transaction(()=>{
   for(const p of db.prepare("SELECT * FROM payments WHERE remind_at<=? AND reminder_sent_at IS NULL AND status IN ('NEW','FORM_SHOWED') AND payment_url IS NOT NULL").all(now)){
    const m=notifyClient(store,p.lead_id,`Напоминание: счёт ещё не оплачен.\n${p.description} — ${(p.amount/100).toFixed(2)} ₽\nТестовая оплата: ${p.payment_url}`,`payment-reminder:${p.id}`);
    if(m)db.prepare('UPDATE payments SET reminder_sent_at=? WHERE id=?').run(now,p.id);
   }
  });
 }
 // A notification sent to a tunnel address that has since moved is lost; asking the bank about open invoices closes the gap.
 let polling=false;
 async function pollPending(){
  if(polling||configIssues().length)return;polling=true;
  try{
   const open=db.prepare(`SELECT id FROM payments WHERE bank_payment_id IS NOT NULL AND mode=? AND terminal_key=? AND created_at>? AND status IN (${unpaid.map(()=>'?').join(',')}) ORDER BY updated_at LIMIT 20`).all(config.mode,config.terminalKey,new Date(Date.now()-7*86400000).toISOString(),...unpaid);
   for(const {id} of open){try{await sync(id);}catch{/* the next round asks again */}}
  }finally{polling=false;}
 }
 return {create,sync,webhook,list,get,tick,pollPending,status:()=>({configured:configIssues().length===0,mode:config.mode,testOnly:true,issues:configIssues(),receiptRequired:Boolean(config.taxation)}),delivery(id){const p=get(id);if(!p)return null;const m=db.prepare('SELECT delivery FROM messages WHERE client_key=?').get(`invoice:${id}`);return m?.delivery??(clientMember(store,p.lead_id)?'not_sent':'client_not_connected');}};
}
