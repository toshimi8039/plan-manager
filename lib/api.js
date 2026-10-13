// 所有 /api/* 請求的處理邏輯。環境需提供 env.DB（Cloudflare D1）
import { hashPassword, verifyPassword, randomHex, sha256Hex, tempPassword } from './crypto.js';
import { ensureSchema } from './schema.js';

export const INITIAL_ADMIN = 'toshimi8039';
// 只用於資料庫還沒有任何使用者時建立管理員；第一次登入後強制改掉
const INITIAL_PASSWORD = '123456';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'sid';

const TASK_STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const now = () => Date.now();

// ---------- 驗證輔助 ----------

function str(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} 為必填`);
    return value;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} 格式錯誤`);
  const v = value.trim();
  if (required && !v) throw new HttpError(400, `${field} 為必填`);
  if (v.length > max) throw new HttpError(400, `${field} 最多 ${max} 個字`);
  return v;
}

function date(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} 日期格式錯誤`);
  return value;
}

function oneOf(value, field, options) {
  if (value === undefined) return undefined;
  if (!options.includes(value)) throw new HttpError(400, `${field} 必須是 ${options.join(' / ')}`);
  return value;
}

function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, '找不到資料');
  return n;
}

function checkNewPassword(password, username) {
  if (typeof password !== 'string') throw new HttpError(400, '請輸入新密碼');
  if (password.length < 8) throw new HttpError(400, '新密碼至少需要 8 個字元');
  if (password.length > 128) throw new HttpError(400, '新密碼最多 128 個字元');
  if (password === INITIAL_PASSWORD) throw new HttpError(400, '不能使用初始密碼');
  if (password.toLowerCase() === username.toLowerCase()) throw new HttpError(400, '密碼不能和帳號相同');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new HttpError(400, '新密碼需同時包含英文字母和數字');
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, '請求內容格式錯誤');
  }
}

// ---------- 使用者與登入狀態 ----------

async function ensureInitialAdmin(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row.n > 0) return;
  const { hash, salt, iterations } = await hashPassword(INITIAL_PASSWORD);
  const t = now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (username, display_name, password_hash, password_salt, password_iterations, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 1, ?, ?)`
    )
    .bind(INITIAL_ADMIN, '管理員', hash, salt, iterations, t, t)
    .run();
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionCookie(token, request, maxAgeSec) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function createSession(db, userId, request) {
  const token = randomHex(32);
  const t = now();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, t + SESSION_TTL_MS, t)
    .run();
  return sessionCookie(token, request, SESSION_TTL_MS / 1000);
}

async function currentSession(db, request) {
  const token = getCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.expires_at < now() || row.disabled) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { tokenHash, user: row };
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    must_change_password: !!u.must_change_password,
  };
}

// ---------- 路由 ----------

const routes = [];
function route(method, pattern, handler, { auth = true, admin = false, allowWhilePasswordExpired = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth, admin, allowWhilePasswordExpired });
}

route('POST', '/auth/login', async ({ db, request }) => {
  const body = await readJson(request);
  const username = str(body.username, '帳號', { max: 64, required: true });
  const password = typeof body.password === 'string' ? body.password : '';
  await ensureInitialAdmin(db);

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (user && user.locked_until && user.locked_until > now()) {
    throw new HttpError(429, '嘗試次數過多，請 15 分鐘後再試');
  }
  // 帳號不存在時也做一次雜湊，讓回應時間一致
  const ok = user ? await verifyPassword(password, user) : (await hashPassword(password), false);
  if (!ok || user.disabled) {
    if (user && !user.disabled) {
      const attempts = user.failed_attempts + 1;
      const locked = attempts >= MAX_FAILED_ATTEMPTS ? now() + LOCK_MS : null;
      await db
        .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .bind(locked ? 0 : attempts, locked, user.id)
        .run();
    }
    throw new HttpError(401, '帳號或密碼錯誤');
  }
  await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
  const cookie = await createSession(db, user.id, request);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
}, { auth: false });

route('POST', '/auth/logout', async ({ db, request, session }) => {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) });
}, { allowWhilePasswordExpired: true });

route('GET', '/auth/me', async ({ session }) => json({ user: publicUser(session.user) }), {
  allowWhilePasswordExpired: true,
});

route('POST', '/auth/change-password', async ({ db, request, session }) => {
  const body = await readJson(request);
  const user = session.user;
  if (!(await verifyPassword(typeof body.current_password === 'string' ? body.current_password : '', user))) {
    throw new HttpError(400, '目前密碼不正確');
  }
  checkNewPassword(body.new_password, user.username);
  if (body.new_password === body.current_password) throw new HttpError(400, '新密碼不能和目前密碼相同');
  const { hash, salt, iterations } = await hashPassword(body.new_password);
  await db
    .prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0, updated_at = ?
       WHERE id = ?`
    )
    .bind(hash, salt, iterations, now(), user.id)
    .run();
  // 其他裝置上的登入狀態全部登出
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, session.tokenHash).run();
  return json({ user: publicUser({ ...user, must_change_password: 0 }) });
}, { allowWhilePasswordExpired: true });

// ----- 計劃 -----

// 計劃進度＝各任務進度依權重加權平均；已完成的任務一律算 100%
const PROJECT_SELECT = `SELECT p.*, u.username AS owner_username,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
    (SELECT CAST(ROUND(COALESCE(
        SUM(t.weight * CASE WHEN t.status = 'done' THEN 100 ELSE t.progress END) / NULLIF(SUM(t.weight), 0), 0)) AS INTEGER)
      FROM tasks t WHERE t.project_id = p.id) AS progress,
    (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.project_id = p.id) AS spent,
    (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS milestone_count,
    (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.done = 1) AS milestone_done,
    (SELECT m.name FROM milestones m WHERE m.project_id = p.id AND m.done = 0 ORDER BY m.due_date LIMIT 1) AS next_milestone_name,
    (SELECT m.due_date FROM milestones m WHERE m.project_id = p.id AND m.done = 0 ORDER BY m.due_date LIMIT 1) AS next_milestone_date
  FROM projects p LEFT JOIN users u ON u.id = p.owner_id`;

function canEditBudget(session, project) {
  return session.user.role === 'admin' || project.owner_id === session.user.id;
}

function withPermissions(project, session) {
  return { ...project, can_edit_budget: canEditBudget(session, project) };
}

route('GET', '/projects', async ({ db, url, session }) => {
  const status = url.searchParams.get('status') || 'active';
  const stmt = db.prepare(`${PROJECT_SELECT} ${status === 'all' ? '' : 'WHERE p.status = ?'} ORDER BY p.updated_at DESC`);
  const { results } = await (status === 'all' ? stmt : stmt.bind(oneOf(status, 'status', ['active', 'archived']))).all();
  return json({ projects: results.map((p) => withPermissions(p, session)) });
});

async function getProject(db, projectId) {
  const p = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(projectId).first();
  if (!p) throw new HttpError(404, '找不到這個計劃');
  return p;
}

function money(value, field, { required = false, positive = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} 為必填`);
    return value === undefined ? undefined : 0;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1e12) throw new HttpError(400, `${field} 請輸入 0 以上的整數金額`);
  if (positive && n === 0) throw new HttpError(400, `${field} 必須大於 0`);
  return n;
}

function checkDateRange(start, end) {
  if (start && end && start > end) throw new HttpError(400, '結束日不能早於開始日');
}

route('POST', '/projects', async ({ db, request, session }) => {
  const body = await readJson(request);
  const start = date(body.start_date, '開始日') ?? null;
  const end = date(body.end_date, '結束日') ?? null;
  checkDateRange(start, end);
  const t = now();
  const r = await db
    .prepare(
      `INSERT INTO projects (name, description, start_date, end_date, budget, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      str(body.name, '計劃名稱', { max: 100, required: true }),
      str(body.description, '說明', { max: 2000 }) ?? '',
      start,
      end,
      money(body.budget, '總預算') ?? 0,
      session.user.id,
      t,
      t
    )
    .run();
  return json({ project: withPermissions(await getProject(db, r.meta.last_row_id), session) }, 201);
});

route('GET', '/projects/:id', async ({ db, params, session }) =>
  json({ project: withPermissions(await getProject(db, id(params.id)), session) })
);

route('PATCH', '/projects/:id', async ({ db, request, params, session }) => {
  const projectId = id(params.id);
  const project = await getProject(db, projectId);
  const body = await readJson(request);
  const budget = money(body.budget, '總預算');
  if (budget !== undefined && !canEditBudget(session, project)) {
    throw new HttpError(403, '只有管理員或計劃建立者可以修改預算');
  }
  const start = date(body.start_date, '開始日');
  const end = date(body.end_date, '結束日');
  checkDateRange(start === undefined ? project.start_date : start, end === undefined ? project.end_date : end);
  await updateRow(db, 'projects', projectId, {
    name: str(body.name, '計劃名稱', { max: 100, required: body.name !== undefined }),
    description: str(body.description, '說明', { max: 2000 }),
    status: oneOf(body.status, 'status', ['active', 'archived']),
    start_date: start,
    end_date: end,
    budget,
  });
  return json({ project: withPermissions(await getProject(db, projectId), session) });
});

route('DELETE', '/projects/:id', async ({ db, params }) => {
  const projectId = id(params.id);
  await getProject(db, projectId);
  await db.batch([
    db.prepare('DELETE FROM expenses WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM budget_items WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM milestones WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM tasks WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM projects WHERE id = ?').bind(projectId),
  ]);
  return json({ ok: true });
});

async function updateRow(db, table, rowId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  await db
    .prepare(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), now(), rowId)
    .run();
}

async function touchProject(db, projectId) {
  await db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now(), projectId).run();
}

// ----- 任務 -----

const TASK_SELECT = `SELECT t.*, u.username AS assignee_username, u.display_name AS assignee_name
  FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id`;

async function getTask(db, taskId) {
  const task = await db.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(taskId).first();
  if (!task) throw new HttpError(404, '找不到這個任務');
  return task;
}

async function checkAssignee(db, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const user = await db.prepare('SELECT id FROM users WHERE id = ? AND disabled = 0').bind(Number(value)).first();
  if (!user) throw new HttpError(400, '負責人不存在');
  return user.id;
}

async function nextPosition(db, projectId, status) {
  const row = await db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM tasks WHERE project_id = ? AND status = ?')
    .bind(projectId, status)
    .first();
  return row.p + 1;
}

function percent(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, '進度請輸入 0 到 100 的整數');
  return n;
}

function weight(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new HttpError(400, '權重請輸入大於 0、最多 1000 的數字');
  return n;
}

// 讓狀態和進度保持一致：完成＝100%，填了部分進度的待辦自動變成進行中
function syncProgress(current, status, progress) {
  if (status === 'done' || progress === 100) return { status: 'done', progress: 100 };
  // 從完成改回其他狀態且沒指定進度時，進度歸零
  if (status !== undefined && progress === undefined && current.status === 'done') return { status, progress: 0 };
  let next = status ?? current.status;
  if (progress !== undefined) {
    if (next === 'done') next = progress > 0 ? 'doing' : 'todo';
    else if (next === 'todo' && progress > 0) next = 'doing';
  }
  return { status: next, progress };
}

route('GET', '/projects/:id/tasks', async ({ db, params }) => {
  const projectId = id(params.id);
  await getProject(db, projectId);
  const { results } = await db
    .prepare(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.position, t.id`)
    .bind(projectId)
    .all();
  return json({ tasks: results });
});

route('POST', '/projects/:id/tasks', async ({ db, request, params }) => {
  const projectId = id(params.id);
  await getProject(db, projectId);
  const body = await readJson(request);
  const synced = syncProgress(
    { status: 'todo', progress: 0 },
    oneOf(body.status, '狀態', TASK_STATUSES),
    percent(body.progress)
  );
  const status = synced.status ?? 'todo';
  const t = now();
  const r = await db
    .prepare(
      `INSERT INTO tasks (project_id, title, description, status, priority, due_date, assignee_id, progress, weight, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      projectId,
      str(body.title, '任務名稱', { max: 200, required: true }),
      str(body.description, '說明', { max: 5000 }) ?? '',
      status,
      oneOf(body.priority, '優先度', PRIORITIES) ?? 'medium',
      date(body.due_date, '截止日') ?? null,
      (await checkAssignee(db, body.assignee_id)) ?? null,
      synced.progress ?? 0,
      weight(body.weight) ?? 1,
      await nextPosition(db, projectId, status),
      t,
      t
    )
    .run();
  await touchProject(db, projectId);
  return json({ task: await getTask(db, r.meta.last_row_id) }, 201);
});

route('PATCH', '/tasks/:id', async ({ db, request, params }) => {
  const taskId = id(params.id);
  const task = await getTask(db, taskId);
  const body = await readJson(request);
  const { status, progress } = syncProgress(task, oneOf(body.status, '狀態', TASK_STATUSES), percent(body.progress));
  let position;
  if (body.position !== undefined) {
    position = Number(body.position);
    if (!Number.isFinite(position)) throw new HttpError(400, 'position 格式錯誤');
  } else if (status && status !== task.status) {
    position = await nextPosition(db, task.project_id, status);
  }
  await updateRow(db, 'tasks', taskId, {
    title: str(body.title, '任務名稱', { max: 200, required: body.title !== undefined }),
    description: str(body.description, '說明', { max: 5000 }),
    status,
    progress,
    weight: weight(body.weight),
    priority: oneOf(body.priority, '優先度', PRIORITIES),
    due_date: date(body.due_date, '截止日'),
    assignee_id: await checkAssignee(db, body.assignee_id),
    position,
  });
  await touchProject(db, task.project_id);
  return json({ task: await getTask(db, taskId) });
});

route('DELETE', '/tasks/:id', async ({ db, params }) => {
  const task = await getTask(db, id(params.id));
  await db.batch([
    db.prepare('UPDATE expenses SET task_id = NULL WHERE task_id = ?').bind(task.id),
    db.prepare('DELETE FROM tasks WHERE id = ?').bind(task.id),
  ]);
  await touchProject(db, task.project_id);
  return json({ ok: true });
});

// ----- 預算與支出 -----

async function budgetProject(db, projectId, session, { write = false } = {}) {
  const project = await getProject(db, projectId);
  if (write && !canEditBudget(session, project)) throw new HttpError(403, '只有管理員或計劃建立者可以修改預算');
  return project;
}

async function checkBudgetItem(db, projectId, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const item = await db
    .prepare('SELECT id FROM budget_items WHERE id = ? AND project_id = ?')
    .bind(Number(value), projectId)
    .first();
  if (!item) throw new HttpError(400, '預算科目不存在');
  return item.id;
}

async function checkProjectTask(db, projectId, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const task = await db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?').bind(Number(value), projectId).first();
  if (!task) throw new HttpError(400, '關聯的任務不存在');
  return task.id;
}

route('GET', '/projects/:id/budget', async ({ db, params, session }) => {
  const project = await budgetProject(db, id(params.id), session);
  const [items, expenses] = await Promise.all([
    db
      .prepare(
        `SELECT b.*, (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.budget_item_id = b.id) AS spent
         FROM budget_items b WHERE b.project_id = ? ORDER BY b.position, b.id`
      )
      .bind(project.id)
      .all(),
    db
      .prepare(
        `SELECT e.*, b.name AS budget_item_name, t.title AS task_title, u.username AS created_by_username
         FROM expenses e
         LEFT JOIN budget_items b ON b.id = e.budget_item_id
         LEFT JOIN tasks t ON t.id = e.task_id
         LEFT JOIN users u ON u.id = e.created_by
         WHERE e.project_id = ? ORDER BY e.spent_on DESC, e.id DESC`
      )
      .bind(project.id)
      .all(),
  ]);
  return json({
    budget: project.budget,
    spent: project.spent,
    can_edit: canEditBudget(session, project),
    items: items.results,
    expenses: expenses.results,
  });
});

route('POST', '/projects/:id/budget-items', async ({ db, request, params, session }) => {
  const project = await budgetProject(db, id(params.id), session, { write: true });
  const body = await readJson(request);
  const pos = await db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM budget_items WHERE project_id = ?').bind(project.id).first();
  const t = now();
  const r = await db
    .prepare('INSERT INTO budget_items (project_id, name, planned_amount, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(project.id, str(body.name, '科目名稱', { max: 50, required: true }), money(body.planned_amount, '預計金額') ?? 0, pos.p, t, t)
    .run();
  await touchProject(db, project.id);
  return json({ id: r.meta.last_row_id }, 201);
});

async function getBudgetItem(db, itemId) {
  const item = await db.prepare('SELECT * FROM budget_items WHERE id = ?').bind(itemId).first();
  if (!item) throw new HttpError(404, '找不到這個預算科目');
  return item;
}

route('PATCH', '/budget-items/:id', async ({ db, request, params, session }) => {
  const item = await getBudgetItem(db, id(params.id));
  await budgetProject(db, item.project_id, session, { write: true });
  const body = await readJson(request);
  await updateRow(db, 'budget_items', item.id, {
    name: str(body.name, '科目名稱', { max: 50, required: body.name !== undefined }),
    planned_amount: money(body.planned_amount, '預計金額'),
  });
  await touchProject(db, item.project_id);
  return json({ ok: true });
});

route('DELETE', '/budget-items/:id', async ({ db, params, session }) => {
  const item = await getBudgetItem(db, id(params.id));
  await budgetProject(db, item.project_id, session, { write: true });
  // 已登記在這個科目的支出保留下來，改成「未分類」
  await db.batch([
    db.prepare('UPDATE expenses SET budget_item_id = NULL WHERE budget_item_id = ?').bind(item.id),
    db.prepare('DELETE FROM budget_items WHERE id = ?').bind(item.id),
  ]);
  await touchProject(db, item.project_id);
  return json({ ok: true });
});

route('POST', '/projects/:id/expenses', async ({ db, request, params, session }) => {
  const project = await budgetProject(db, id(params.id), session, { write: true });
  const body = await readJson(request);
  const spentOn = date(body.spent_on, '日期');
  if (!spentOn) throw new HttpError(400, '日期 為必填');
  const t = now();
  const r = await db
    .prepare(
      `INSERT INTO expenses (project_id, budget_item_id, task_id, spent_on, amount, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      project.id,
      (await checkBudgetItem(db, project.id, body.budget_item_id)) ?? null,
      (await checkProjectTask(db, project.id, body.task_id)) ?? null,
      spentOn,
      money(body.amount, '金額', { required: true, positive: true }),
      str(body.description, '說明', { max: 500 }) ?? '',
      session.user.id,
      t,
      t
    )
    .run();
  await touchProject(db, project.id);
  return json({ id: r.meta.last_row_id }, 201);
});

async function getExpense(db, expenseId) {
  const e = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(expenseId).first();
  if (!e) throw new HttpError(404, '找不到這筆支出');
  return e;
}

route('PATCH', '/expenses/:id', async ({ db, request, params, session }) => {
  const expense = await getExpense(db, id(params.id));
  await budgetProject(db, expense.project_id, session, { write: true });
  const body = await readJson(request);
  const spentOn = date(body.spent_on, '日期');
  if (spentOn === null) throw new HttpError(400, '日期 為必填');
  await updateRow(db, 'expenses', expense.id, {
    spent_on: spentOn,
    amount: body.amount === undefined ? undefined : money(body.amount, '金額', { required: true, positive: true }),
    budget_item_id: await checkBudgetItem(db, expense.project_id, body.budget_item_id),
    task_id: await checkProjectTask(db, expense.project_id, body.task_id),
    description: str(body.description, '說明', { max: 500 }),
  });
  await touchProject(db, expense.project_id);
  return json({ ok: true });
});

route('DELETE', '/expenses/:id', async ({ db, params, session }) => {
  const expense = await getExpense(db, id(params.id));
  await budgetProject(db, expense.project_id, session, { write: true });
  await db.prepare('DELETE FROM expenses WHERE id = ?').bind(expense.id).run();
  await touchProject(db, expense.project_id);
  return json({ ok: true });
});

// ----- 里程碑 -----

route('GET', '/projects/:id/milestones', async ({ db, params }) => {
  const project = await getProject(db, id(params.id));
  const { results } = await db
    .prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY due_date, id')
    .bind(project.id)
    .all();
  return json({ milestones: results });
});

route('POST', '/projects/:id/milestones', async ({ db, request, params }) => {
  const project = await getProject(db, id(params.id));
  const body = await readJson(request);
  const due = date(body.due_date, '日期');
  if (!due) throw new HttpError(400, '日期 為必填');
  const t = now();
  const r = await db
    .prepare('INSERT INTO milestones (project_id, name, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(project.id, str(body.name, '里程碑名稱', { max: 100, required: true }), due, t, t)
    .run();
  await touchProject(db, project.id);
  return json({ id: r.meta.last_row_id }, 201);
});

async function getMilestone(db, milestoneId) {
  const m = await db.prepare('SELECT * FROM milestones WHERE id = ?').bind(milestoneId).first();
  if (!m) throw new HttpError(404, '找不到這個里程碑');
  return m;
}

route('PATCH', '/milestones/:id', async ({ db, request, params }) => {
  const m = await getMilestone(db, id(params.id));
  const body = await readJson(request);
  const due = date(body.due_date, '日期');
  if (due === null) throw new HttpError(400, '日期 為必填');
  const done = body.done === undefined ? undefined : body.done ? 1 : 0;
  await updateRow(db, 'milestones', m.id, {
    name: str(body.name, '里程碑名稱', { max: 100, required: body.name !== undefined }),
    due_date: due,
    done,
    done_at: done === undefined ? undefined : done ? now() : null,
  });
  await touchProject(db, m.project_id);
  return json({ ok: true });
});

route('DELETE', '/milestones/:id', async ({ db, params }) => {
  const m = await getMilestone(db, id(params.id));
  await db.prepare('DELETE FROM milestones WHERE id = ?').bind(m.id).run();
  await touchProject(db, m.project_id);
  return json({ ok: true });
});

// ----- 總覽 -----

function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

route('GET', '/dashboard', async ({ db, url, session }) => {
  // 「今天」以使用者裝置的日期為準（伺服器是 UTC）
  const today = date(url.searchParams.get('today') || undefined, 'today') || new Date().toISOString().slice(0, 10);
  const soon = addDays(today, 7);
  const [projects, tasks, milestones] = await Promise.all([
    db.prepare(`${PROJECT_SELECT} WHERE p.status = 'active' ORDER BY p.end_date IS NULL, p.end_date, p.id`).all(),
    db
      .prepare(
        `SELECT t.id, t.title, t.due_date, t.status, t.priority, t.progress, t.project_id, p.name AS project_name,
           u.username AS assignee_username, u.display_name AS assignee_name
         FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id
         WHERE p.status = 'active' AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ?
         ORDER BY t.due_date, t.id LIMIT 100`
      )
      .bind(soon)
      .all(),
    db
      .prepare(
        `SELECT m.*, p.name AS project_name FROM milestones m JOIN projects p ON p.id = m.project_id
         WHERE p.status = 'active' AND m.done = 0 AND m.due_date <= ?
         ORDER BY m.due_date, m.id LIMIT 100`
      )
      .bind(addDays(today, 30))
      .all(),
  ]);
  return json({
    today,
    projects: projects.results.map((p) => withPermissions(p, session)),
    overdue_tasks: tasks.results.filter((t) => t.due_date < today),
    upcoming_tasks: tasks.results.filter((t) => t.due_date >= today),
    milestones: milestones.results,
  });
});

// ----- 使用者管理 -----

route('GET', '/users', async ({ db, session }) => {
  const isAdmin = session.user.role === 'admin';
  const cols = isAdmin
    ? 'id, username, display_name, role, disabled, must_change_password, locked_until, created_at'
    : 'id, username, display_name';
  const where = isAdmin ? '' : 'WHERE disabled = 0';
  const { results } = await db.prepare(`SELECT ${cols} FROM users ${where} ORDER BY username`).all();
  return json({ users: results });
});

route('POST', '/users', async ({ db, request }) => {
  const body = await readJson(request);
  const username = str(body.username, '帳號', { max: 32, required: true });
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '帳號只能用英文、數字、底線、點或減號，3 到 32 個字');
  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, '這個帳號已經存在');
  const password = tempPassword();
  const { hash, salt, iterations } = await hashPassword(password);
  const t = now();
  const r = await db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, password_salt, password_iterations, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      username,
      str(body.display_name, '顯示名稱', { max: 50 }) || null,
      hash,
      salt,
      iterations,
      oneOf(body.role, '角色', ['admin', 'member']) ?? 'member',
      t,
      t
    )
    .run();
  return json({ user: { id: r.meta.last_row_id, username }, temp_password: password }, 201);
}, { admin: true });

route('PATCH', '/users/:id', async ({ db, request, params, session }) => {
  const userId = id(params.id);
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw new HttpError(404, '找不到這個使用者');
  const body = await readJson(request);
  const role = oneOf(body.role, '角色', ['admin', 'member']);
  const disabled = body.disabled === undefined ? undefined : body.disabled ? 1 : 0;
  if (userId === session.user.id && (role === 'member' || disabled === 1)) {
    throw new HttpError(400, '不能停用自己或移除自己的管理員權限');
  }
  await updateRow(db, 'users', userId, {
    display_name: str(body.display_name, '顯示名稱', { max: 50 }),
    role,
    disabled,
  });
  if (disabled === 1) await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return json({ ok: true });
}, { admin: true });

route('POST', '/users/:id/reset-password', async ({ db, params }) => {
  const userId = id(params.id);
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw new HttpError(404, '找不到這個使用者');
  const password = tempPassword();
  const { hash, salt, iterations } = await hashPassword(password);
  await db
    .prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1,
         failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`
    )
    .bind(hash, salt, iterations, now(), userId)
    .run();
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return json({ temp_password: password });
}, { admin: true });

// ---------- 入口 ----------

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  try {
    if (!env.DB) throw new HttpError(500, '尚未設定資料庫（D1 binding DB）');
    const db = env.DB;
    await ensureSchema(db);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // 防 CSRF：只接受同源、JSON 格式的寫入請求
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, '不允許的來源');
      // 一般 HTML 表單只能送 POST，且無法送 JSON；DELETE 跨站時瀏覽器會先擋下
      const type = request.headers.get('Content-Type') || '';
      if (request.method !== 'DELETE' && !type.startsWith('application/json')) throw new HttpError(415, '請使用 JSON 格式');
    }

    let matched = false;
    for (const r of routes) {
      const m = path.match(r.re);
      if (!m) continue;
      matched = true;
      if (r.method !== request.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let session = null;
      if (r.auth) {
        session = await currentSession(db, request);
        if (!session) throw new HttpError(401, '請先登入');
        if (session.user.must_change_password && !r.allowWhilePasswordExpired) {
          throw new HttpError(403, '請先修改密碼');
        }
        if (r.admin && session.user.role !== 'admin') throw new HttpError(403, '只有管理員可以使用這個功能');
      }
      return await r.handler({ db, request, url, params, session });
    }
    throw new HttpError(matched ? 405 : 404, matched ? '不支援這個方法' : '找不到這個 API');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: '伺服器發生錯誤' }, 500);
  }
}
