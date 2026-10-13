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
