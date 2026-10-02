export function initCommerceStore(store){
 const db=store.db;
 const add=(table,fields)=>{const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const [name,type] of Object.entries(fields))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
 add('leads',{client_chat_id:'TEXT',client_profile:"TEXT NOT NULL DEFAULT '{}'",paid:'INTEGER NOT NULL DEFAULT 0',paid_amount:'INTEGER NOT NULL DEFAULT 0',paid_at:'TEXT'});
 add('outbox',{kind:"TEXT NOT NULL DEFAULT 'telegram'",markup:'TEXT'});
 db.exec(`CREATE TABLE IF NOT EXISTS client_members(chat_id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL,lead_id TEXT UNIQUE NOT NULL,profile TEXT NOT NULL,chat_profile TEXT NOT NULL,contact_profile TEXT,notifications_enabled INTEGER NOT NULL DEFAULT 1,broadcast_enabled INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS client_events(update_id INTEGER PRIMARY KEY,chat_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS client_invites(token_hash TEXT PRIMARY KEY,lead_id TEXT NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT);
 CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,order_id TEXT UNIQUE NOT NULL,terminal_key TEXT NOT NULL,mode TEXT NOT NULL,amount INTEGER NOT NULL,description TEXT NOT NULL,bank_payment_id TEXT UNIQUE,payment_url TEXT,status TEXT NOT NULL,paid_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by TEXT NOT NULL,request_key TEXT UNIQUE NOT NULL,remind_at TEXT,reminder_sent_at TEXT,last_error TEXT);
 CREATE TABLE IF NOT EXISTS payment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,payment_id TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,body TEXT NOT NULL,tag TEXT,recipients TEXT NOT NULL,state TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,sent_at TEXT);
 CREATE INDEX IF NOT EXISTS idx_payments_lead ON payments(lead_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_client_events_chat ON client_events(chat_id,update_id);`);
}
