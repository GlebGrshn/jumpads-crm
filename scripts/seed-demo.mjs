// Fills the CRM with demo staff, leads on every stage, tasks and history. Runs once per database.
// Demo staff get random passwords that are never stored: they populate the team, nobody logs in as them.
// Usage: DB_PATH=./data/crm.sqlite node scripts/seed-demo.mjs   (in Docker: docker exec jumpads-crm node scripts/seed-demo.mjs)
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../src/store.js';

const store = openStore(process.env.DB_PATH ?? './data/crm.sqlite');
const db = store.db;
if (db.prepare("SELECT 1 FROM meta WHERE key='demo_seeded'").get()) {
  console.log('Demo data already present; nothing to do.');
  process.exit(0);
}

const staff = [
  ['olga_director', 'admin'],
  ['ivan_sales', 'manager'],
  ['maria_sales', 'manager'],
  ['dmitry_smm', 'manager'],
  ['kate_analyst', 'observer']
];
const users = {};
for (const [username, role] of staff) {
  const existing = store.users().find(u => u.username === username);
  users[username] = existing ?? await store.register({ username, password: randomBytes(18).toString('base64url'), role }, true);
}

const day = 86400000, now = Date.now();
const at = daysAgo => new Date(now - daysAgo * day).toISOString();
// [name, contact, company, request, stage, tags, budget, owner, source, days ago, notes]
const leads = [
  ['Алексей Смирнов', '+7 900 120-45-11', 'Кофейня «Зерно»', 'Нужен лендинг для новой точки и запуск рекламы на район.', 'new', ['лендинг', 'таргет'], 60000, null, 'telegram', 0.2, ''],
  ['Екатерина Орлова', '@orlova_flowers', 'Цветочная мастерская', 'Хотим вести Instagram и VK, 12 постов в месяц.', 'new', ['smm'], 45000, null, 'telegram', 0.6, ''],
  ['Роман Белов', 'roman.belov@example.com', 'Автосервис «Гараж 24»', 'Сайт-визитка с онлайн-записью на ремонт.', 'new', ['сайт'], 90000, 'ivan_sales', 'manual', 1, 'Пришёл по рекомендации от «Зерна».'],
  ['Наталья Кузнецова', '+7 900 233-18-07', 'Стоматология «Улыбка»', 'Контекстная реклама в Яндекс Директ, бюджет на клики 80 тыс./мес.', 'working', ['контекст', 'приоритет'], 120000, 'maria_sales', 'manual', 3, 'Просит отчёт раз в неделю.'],
  ['Игорь Волков', '@volkov_fitness', 'Фитнес-клуб «Пульс»', 'Запуск таргета VK на абонементы к сезону.', 'working', ['таргет', 'telegram'], 75000, 'ivan_sales', 'telegram', 4, ''],
  ['Светлана Морозова', '+7 900 417-62-90', 'Онлайн-школа английского', 'Воронка в Telegram: бот, автосообщения, лид-магнит.', 'working', ['telegram-бот', 'воронка'], 150000, 'dmitry_smm', 'telegram', 5, 'Есть готовый лид-магнит, нужен бот.'],
  ['Михаил Лебедев', 'm.lebedev@example.com', 'Мебельная фабрика «Дуб»', 'Редизайн каталога и SEO-продвижение.', 'proposal', ['seo', 'сайт'], 240000, 'maria_sales', 'manual', 7, 'КП отправлено 2 дня назад, ждём ответа.'],
  ['Анна Соколова', '@anna_bakery', 'Пекарня «Булка»', 'SMM и съёмка контента для соцсетей.', 'proposal', ['smm', 'контент'], 80000, 'dmitry_smm', 'telegram', 8, ''],
  ['Павел Новиков', '+7 900 505-33-21', 'Строительная компания «Каркас»', 'Лендинг под каркасные дома и квиз для заявок.', 'won', ['лендинг', 'квиз', 'приоритет'], 180000, 'ivan_sales', 'manual', 12, 'Договор подписан, старт в понедельник.'],
  ['Ольга Попова', 'olga.popova@example.com', 'Салон красоты «Лотос»', 'Ведение VK и таргет на запись.', 'won', ['smm', 'таргет'], 95000, 'maria_sales', 'manual', 15, ''],
  ['Денис Фёдоров', '@denis_fedorov', 'Частное лицо', 'Сайт-портфолио фотографа.', 'closed', ['сайт'], 30000, 'ivan_sales', 'telegram', 18, 'Отказ: выбрал конструктор сайтов.'],
  ['Юлия Васильева', '+7 900 688-14-52', 'Юридическая фирма «Право»', 'Контекстная реклама по банкротству.', 'closed', ['контекст'], 110000, 'maria_sales', 'manual', 20, 'Отложили до следующего квартала.']
];
const stageNames = { new: 'Новый', working: 'В работе', proposal: 'Предложение', won: 'Сделка', closed: 'Закрыт' };
const history = db.prepare('INSERT INTO activity VALUES (?,?,?,?,?)');
const created = {};

store.transaction(() => {
  for (const [name, contact, company, request, status, tags, budget, owner, source, ago, notes] of leads) {
    const lead = store.create({ name, contact, company, request, status, tags: source === 'telegram' ? [...new Set(['telegram', ...tags])] : tags, budget, owner_id: owner ? users[owner].id : null, notes }, source);
    db.prepare('UPDATE leads SET created_at=? WHERE id=?').run(at(ago), lead.id);
    created[name] = lead;
    history.run(randomUUID(), lead.id, source === 'telegram' ? 'Telegram-бот' : owner ?? 'olga_director', source === 'telegram' ? 'Получена заявка из Telegram' : 'Создан лид', at(ago));
    if (owner) history.run(randomUUID(), lead.id, 'olga_director', `Назначен ответственный: ${owner}`, at(ago - 0.05));
    const path = ['working', 'proposal', 'won'].slice(0, ['new', 'working', 'proposal', 'won'].indexOf(status));
    if (status === 'closed') path.push('closed');
    path.forEach((stage, i) => history.run(randomUUID(), lead.id, owner ?? 'olga_director', `Этап: ${stageNames[stage]}`, at(ago * (1 - (i + 1) / (path.length + 1)))));
  }

  const task = (title, lead, assignee, dueInHours, status = 'todo', priority = 'normal', description = '') => {
    const due = new Date(now + dueInHours * 3600000).toISOString();
    store.saveTask({ title, description, assignee_id: users[assignee].id, lead_id: created[lead].id, due_at: due, remind_at: dueInHours > 0 ? new Date(now + (dueInHours - 1) * 3600000).toISOString() : null, status, priority }, users.olga_director);
  };
  task('Позвонить и уточнить район рекламы', 'Алексей Смирнов', 'ivan_sales', 3, 'todo', 'high');
  task('Подготовить медиаплан на ноябрь', 'Наталья Кузнецова', 'maria_sales', 26, 'doing');
  task('Собрать сценарий бота и лид-магнит', 'Светлана Морозова', 'dmitry_smm', 50, 'doing');
  task('Напомнить о коммерческом предложении', 'Михаил Лебедев', 'maria_sales', -20, 'todo', 'high', 'КП отправлено, ответа нет.');
  task('Согласовать контент-план', 'Анна Соколова', 'dmitry_smm', -4, 'todo');
  task('Выставить счёт за первый этап', 'Павел Новиков', 'ivan_sales', -30, 'done');

  for (const [author, body] of [
    ['olga_director', 'Коллеги, на этой неделе приоритет — «Каркас» и «Улыбка».'],
    ['maria_sales', 'По «Дубу» КП отправлено, жду обратную связь.'],
    ['dmitry_smm', 'Для онлайн-школы набросал сценарий бота, посмотрите в задаче.']
  ]) store.addMessage({ kind: 'team', sender_id: users[author].id, author, body });

  db.prepare("INSERT INTO meta VALUES ('demo_seeded',?)").run(new Date().toISOString());
});
store.close();
console.log(`Demo data added: ${staff.length} staff, ${leads.length} leads, 6 tasks, 3 team messages.`);
