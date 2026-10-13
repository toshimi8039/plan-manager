import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/api.js';
import { createD1 } from './d1-shim.js';

function client() {
  const env = { DB: createD1() };
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const req = new Request('https://app.test/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await handleApi(req, env);
    const set = res.headers.get('Set-Cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  }
  return { call, env, clearCookie: () => (cookie = '') };
}

async function loginAndChange(c) {
  await c.call('POST', '/auth/login', { username: 'toshimi8039', password: '123456' });
  await c.call('POST', '/auth/change-password', { current_password: '123456', new_password: 'Secret123' });
}

test('第一次登入建立管理員，必須先改密碼', async () => {
  const c = client();
  const login = await c.call('POST', '/auth/login', { username: 'toshimi8039', password: '123456' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');
  assert.equal(login.body.user.must_change_password, true);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /Secure/);

  assert.equal((await c.call('GET', '/projects')).status, 403);
  assert.equal((await c.call('POST', '/auth/change-password', { current_password: '123456', new_password: 'short1' })).status, 400);
  assert.equal((await c.call('POST', '/auth/change-password', { current_password: '123456', new_password: 'abcdefgh' })).status, 400);
  const ok = await c.call('POST', '/auth/change-password', { current_password: '123456', new_password: 'Secret123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.must_change_password, false);
  assert.equal((await c.call('GET', '/projects')).status, 200);

  // 改密碼後初始密碼失效
  c.clearCookie();
  assert.equal((await c.call('POST', '/auth/login', { username: 'toshimi8039', password: '123456' })).status, 401);
  assert.equal((await c.call('POST', '/auth/login', { username: 'toshimi8039', password: 'Secret123' })).status, 200);
});

test('資料庫不存明碼', async () => {
  const c = client();
  await loginAndChange(c);
  const row = c.env.DB.raw.prepare('SELECT * FROM users').get();
  assert.ok(!JSON.stringify(row).includes('Secret123'));
  assert.equal(row.password_hash.length, 64);
});

test('連續輸錯 5 次會鎖定', async () => {
  const c = client();
  await loginAndChange(c);
  c.clearCookie();
  for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/auth/login', { username: 'toshimi8039', password: 'x' })).status, 401);
  assert.equal((await c.call('POST', '/auth/login', { username: 'toshimi8039', password: 'Secret123' })).status, 429);
});

test('計劃與任務的新增、修改、進度、刪除', async () => {
  const c = client();
  await loginAndChange(c);
  const p = await c.call('POST', '/projects', { name: '計劃 A', end_date: '2026-12-31' });
  assert.equal(p.status, 201);
  const pid = p.body.project.id;
  const t1 = await c.call('POST', `/projects/${pid}/tasks`, { title: '任務 1', priority: 'high', assignee_id: 1 });
  await c.call('POST', `/projects/${pid}/tasks`, { title: '任務 2' });
  assert.equal(t1.body.task.assignee_username, 'toshimi8039');
  await c.call('PATCH', `/tasks/${t1.body.task.id}`, { status: 'done' });
  const got = await c.call('GET', `/projects/${pid}`);
  assert.equal(got.body.project.task_count, 2);
  assert.equal(got.body.project.done_count, 1);
  assert.equal((await c.call('POST', `/projects/${pid}/tasks`, { title: '' })).status, 400);
  assert.equal((await c.call('PATCH', `/tasks/${t1.body.task.id}`, { due_date: '12/31' })).status, 400);

  await c.call('PATCH', `/projects/${pid}`, { status: 'archived' });
  assert.equal((await c.call('GET', '/projects')).body.projects.length, 0);
  assert.equal((await c.call('GET', '/projects?status=archived')).body.projects.length, 1);

  assert.equal((await c.call('DELETE', `/projects/${pid}`)).status, 200);
  assert.equal((await c.call('GET', `/projects/${pid}/tasks`)).status, 404);
});

test('管理員建立使用者、臨時密碼需改、一般成員不能管理使用者', async () => {
  const c = client();
  await loginAndChange(c);
  const u = await c.call('POST', '/users', { username: 'alice' });
  assert.equal(u.status, 201);
  assert.equal((await c.call('POST', '/users', { username: 'alice' })).status, 409);

  c.clearCookie();
  const login = await c.call('POST', '/auth/login', { username: 'alice', password: u.body.temp_password });
  assert.equal(login.body.user.must_change_password, true);
  await c.call('POST', '/auth/change-password', { current_password: u.body.temp_password, new_password: 'Alice2026' });
  assert.equal((await c.call('POST', '/users', { username: 'bob' })).status, 403);
  const list = await c.call('GET', '/users');
  assert.deepEqual(Object.keys(list.body.users[0]).sort(), ['display_name', 'id', 'username']);
});

test('拒絕跨站來源與非 JSON 的寫入', async () => {
  const c = client();
  await loginAndChange(c);
  assert.equal((await c.call('POST', '/projects', { name: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  const res = await handleApi(new Request('https://app.test/api/auth/login', { method: 'POST', body: 'username=a' }), c.env);
  assert.equal(res.status, 415);
});

test('手動建立過舊版資料表的資料庫會自動升級並保留資料', async () => {
  const { createD1 } = await import('./d1-shim.js');
  const db = createD1();
  // 模擬第一版時在 Console 手動執行的 SQL
  db.raw.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    must_change_password INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT, end_date TEXT, owner_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', due_date TEXT, assignee_id INTEGER, position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO projects (name, created_at, updated_at) VALUES ('舊計劃', 1, 1);
    INSERT INTO tasks (project_id, title, status, created_at, updated_at) VALUES (1, '舊任務', 'done', 1, 1);`);
  const env = { DB: db };
  const req = (path, body, cookie) => handleApi(new Request('https://app.test/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const login = await req('/auth/login', { username: 'toshimi8039', password: '123456' });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  await req('/auth/change-password', { current_password: '123456', new_password: 'Secret123' }, cookie);
  const p = await (await req('/projects/1', null, cookie)).json();
  assert.equal(p.project.name, '舊計劃');
  assert.equal(p.project.progress, 100);
  assert.equal(p.project.budget, 0);
  assert.equal(db.raw.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 2);
});

test('任務進度依權重計算計劃進度，狀態與進度同步', async () => {
  const c = client();
  await loginAndChange(c);
  const pid = (await c.call('POST', '/projects', { name: 'P' })).body.project.id;
  const a = (await c.call('POST', `/projects/${pid}/tasks`, { title: 'A', weight: 3, progress: 50 })).body.task;
  assert.equal(a.status, 'doing');
  const b = (await c.call('POST', `/projects/${pid}/tasks`, { title: 'B', weight: 1 })).body.task;
  // (3*50 + 1*0) / 4 = 37.5 → 38
  assert.equal((await c.call('GET', `/projects/${pid}`)).body.project.progress, 38);
  const done = (await c.call('PATCH', `/tasks/${b.id}`, { status: 'done' })).body.task;
  assert.equal(done.progress, 100);
  // (150 + 100) / 4 = 62.5 → 63
  assert.equal((await c.call('GET', `/projects/${pid}`)).body.project.progress, 63);
  assert.equal((await c.call('PATCH', `/tasks/${a.id}`, { progress: 100 })).body.task.status, 'done');
  assert.equal((await c.call('PATCH', `/tasks/${a.id}`, { status: 'doing' })).body.task.progress, 0);
  assert.equal((await c.call('PATCH', `/tasks/${a.id}`, { progress: 120 })).status, 400);
  assert.equal((await c.call('PATCH', `/tasks/${a.id}`, { weight: 0 })).status, 400);
});

test('預算、科目、支出與權限', async () => {
  const c = client();
  await loginAndChange(c);
  const pid = (await c.call('POST', '/projects', { name: 'P', budget: 100000 })).body.project.id;
  const item = (await c.call('POST', `/projects/${pid}/budget-items`, { name: '設備', planned_amount: 60000 })).body.id;
  await c.call('POST', `/projects/${pid}/expenses`, { spent_on: '2026-10-01', amount: 25000, budget_item_id: item, description: '筆電' });
  await c.call('POST', `/projects/${pid}/expenses`, { spent_on: '2026-10-02', amount: 5000 });
  assert.equal((await c.call('POST', `/projects/${pid}/expenses`, { spent_on: '2026-10-02', amount: 0 })).status, 400);
  assert.equal((await c.call('POST', `/projects/${pid}/expenses`, { spent_on: '2026-10-02', amount: 1.5 })).status, 400);

  let b = (await c.call('GET', `/projects/${pid}/budget`)).body;
  assert.equal(b.budget, 100000);
  assert.equal(b.spent, 30000);
  assert.equal(b.items[0].spent, 25000);
  assert.equal(b.expenses.length, 2);
  assert.equal(b.can_edit, true);

  await c.call('DELETE', `/budget-items/${item}`);
  b = (await c.call('GET', `/projects/${pid}/budget`)).body;
  assert.equal(b.items.length, 0);
  assert.equal(b.spent, 30000);

  // 一般成員可以看預算，但不能改
  const u = (await c.call('POST', '/users', { username: 'member1' })).body;
  c.clearCookie();
  await c.call('POST', '/auth/login', { username: 'member1', password: u.temp_password });
  await c.call('POST', '/auth/change-password', { current_password: u.temp_password, new_password: 'Member123' });
  b = (await c.call('GET', `/projects/${pid}/budget`)).body;
  assert.equal(b.can_edit, false);
  assert.equal((await c.call('PATCH', `/projects/${pid}`, { budget: 1 })).status, 403);
  assert.equal((await c.call('POST', `/projects/${pid}/expenses`, { spent_on: '2026-10-03', amount: 1 })).status, 403);
  assert.equal((await c.call('PATCH', `/projects/${pid}`, { name: '改名' })).status, 200);
  // 自己建立的計劃可以改預算
  const own = (await c.call('POST', '/projects', { name: '成員的計劃' })).body.project;
  assert.equal(own.can_edit_budget, true);
  assert.equal((await c.call('PATCH', `/projects/${own.id}`, { budget: 500 })).body.project.budget, 500);
});

test('里程碑與總覽', async () => {
  const c = client();
  await loginAndChange(c);
  const pid = (await c.call('POST', '/projects', { name: 'P', start_date: '2026-10-01', end_date: '2026-12-31' })).body.project.id;
  assert.equal((await c.call('POST', '/projects', { name: 'X', start_date: '2026-12-01', end_date: '2026-01-01' })).status, 400);
  const m1 = (await c.call('POST', `/projects/${pid}/milestones`, { name: '設計定稿', due_date: '2026-10-10' })).body.id;
  await c.call('POST', `/projects/${pid}/milestones`, { name: '上線', due_date: '2026-12-31' });
  await c.call('POST', `/projects/${pid}/tasks`, { title: '逾期任務', due_date: '2026-10-05' });
  await c.call('POST', `/projects/${pid}/tasks`, { title: '本週任務', due_date: '2026-10-15' });
  await c.call('POST', `/projects/${pid}/tasks`, { title: '很久以後', due_date: '2026-12-01' });

  let p = (await c.call('GET', `/projects/${pid}`)).body.project;
  assert.equal(p.next_milestone_name, '設計定稿');
  await c.call('PATCH', `/milestones/${m1}`, { done: true });
  p = (await c.call('GET', `/projects/${pid}`)).body.project;
  assert.equal(p.next_milestone_name, '上線');
  assert.equal(p.milestone_done, 1);

  const d = (await c.call('GET', '/dashboard?today=2026-10-13')).body;
  assert.deepEqual(d.overdue_tasks.map((t) => t.title), ['逾期任務']);
  assert.deepEqual(d.upcoming_tasks.map((t) => t.title), ['本週任務']);
  assert.deepEqual(d.milestones.map((m) => m.name), []);
  assert.equal(d.projects.length, 1);

  assert.equal((await c.call('DELETE', `/projects/${pid}`)).status, 200);
});
