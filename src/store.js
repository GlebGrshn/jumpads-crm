import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extendStore,fail } from './crm.js';
export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL, request TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL);`);
  const decode = row => row && ({ ...row, tags: JSON.parse(row.tags) });
  const notifyOwner = lead => store.notifyUsers([lead.owner_id], `🙋 Вам назначен лид: ${lead.name}\n${lead.request.slice(0, 500)}`, { inline_keyboard: [[{ text: 'Открыть', callback_data: `ld:${lead.id}` }]] });
  const store = {
    db,
    list: () => db.prepare('SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC').all().map(decode),
    get: id => decode(db.prepare('SELECT * FROM leads WHERE id=?').get(id)),
    remove(id,actor) {
      const lead=store.get(id);if(!lead)throw fail(404,'Лид не найден');if(lead.deleted_at)return;
      store.transaction(()=>{
        db.prepare('UPDATE leads SET deleted_at=?,archived=1 WHERE id=?').run(new Date().toISOString(),id);
        store.activity(id,actor,'Лид удалён из CRM. История, задачи и платежи сохранены.');
      });
    },
    // actorId: who made the change, so people are not notified about leads they assigned to themselves.
    create(input, source = 'manual', actorId = null) {
      const v = validateLead(input);
      const lead = { id: randomUUID(), ...v, source, created_at: new Date().toISOString() };
      db.prepare('INSERT INTO leads (id,name,contact,request,source,status,tags,created_at,company,budget,owner_id,notes,telegram_chat_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(lead.id, lead.name, lead.contact, lead.request, source, lead.status, JSON.stringify(lead.tags), lead.created_at,v.company,v.budget,v.owner_id,v.notes,input.telegram_chat_id ?? null);
      if (v.owner_id && v.owner_id !== actorId) notifyOwner(lead);
      return store.get(lead.id);
    },
    update(id, input, actorId = null) {
      const old = store.get(id);
      if (!old) return null;
      if(old.deleted_at)throw fail(404,'Лид удалён');
      const v = validateLead({...old,...input});
      db.prepare('UPDATE leads SET name=?,contact=?,request=?,status=?,tags=?,company=?,budget=?,owner_id=?,notes=? WHERE id=?').run(v.name,v.contact,v.request,v.status,JSON.stringify(v.tags),v.company,v.budget,v.owner_id,v.notes,id);
      if (v.owner_id && v.owner_id !== old.owner_id && v.owner_id !== actorId) notifyOwner({ ...v, id });
      return store.get(id);
    },
    close: () => db.close()
  };
  return extendStore(store);
}
export function validateLead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректная заявка');
  const v = {};
  for (const [key, label, max] of [['name','Имя',120],['contact','Контакт',200],['request','Запрос',4000]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) throw new Error(`${label}: от 1 до ${max} символов`);
    v[key] = input[key].trim();
  }
  v.status = input.status ?? 'new';
  if (!['new','working','proposal','won','paid','closed'].includes(v.status)) throw new Error('Неизвестный статус');
  if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).length > 20) throw new Error('Не более 20 тегов');
  v.tags = [...new Set((input.tags ?? []).map(tag => {
    if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > 40) throw new Error('Тег: от 1 до 40 символов');
    return tag.trim().toLocaleLowerCase('ru');
  }))];
  for (const [key,max] of [['company',200],['notes',8000]]) {
    if (typeof (input[key] ?? '') !== 'string' || (input[key] ?? '').length > max) throw new Error(`${key}: не более ${max} символов`);
    v[key]=(input[key] ?? '').trim();
  }
  v.budget=input.budget ?? 0;
  if (typeof v.budget !== 'number' || !Number.isFinite(v.budget) || v.budget<0 || v.budget>1e12) throw new Error('Некорректная сумма сделки');
  v.owner_id=input.owner_id || null;
  if (v.owner_id!==null && typeof v.owner_id!=='string') throw new Error('Некорректный ответственный');
  return v;
}
