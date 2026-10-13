// 計劃管理前端：單頁 App，以網址 hash 切換畫面
const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const topbar = document.getElementById('topbar');

const STATUS = { todo: '待辦', doing: '進行中', done: '完成' };
const PRIORITY = { high: '高', medium: '中', low: '低' };

let me = null;
let usersCache = null;

// ---------- 工具 ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(value) {
  return value ? value.replaceAll('-', '/') : '';
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  if (res.status === 401 && path !== '/auth/login') {
    me = null;
    go('#/login');
    throw new Error(data.error || '請先登入');
  }
  if (res.status === 403 && data.error === '請先修改密碼') {
    me && (me.must_change_password = true);
    go('#/password');
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `發生錯誤（${res.status}）`);
  return data;
}

// 非同步畫面載入完成時，若使用者已切到別頁就不再覆蓋畫面
function stillOn() {
  const hash = location.hash;
  return () => location.hash === hash;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// 送出表單時鎖住按鈕並把錯誤顯示在表單內
function bindForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const err = form.querySelector('.error');
    if (err) err.textContent = '';
    btn && (btn.disabled = true);
    try {
      await handler(formData(form));
    } catch (error) {
      if (err) err.textContent = error.message;
      else toast(error.message);
    } finally {
      btn && (btn.disabled = false);
    }
  });
}

function setProgress(root = app) {
  root.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = Math.min(100, el.dataset.pct) + '%'; });
  root.querySelectorAll('[data-left]').forEach((el) => { el.style.left = Math.min(100, el.dataset.left) + '%'; });
}

const money = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 });
function fmtMoney(n) {
  return money.format(n || 0);
}

function dayNumber(day) {
  return Math.round(new Date(day + 'T00:00:00Z').getTime() / 86400000);
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 依開始日～結束日算出「今天應該完成幾 %」，沒有結束日就無法判斷
function expectedProgress(p) {
  if (!p.end_date) return null;
  const start = dayNumber(p.start_date || localDay(p.created_at));
  const end = dayNumber(p.end_date) + 1;
  const now = dayNumber(today());
  if (end <= start) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

// 回傳 { cls, text }：cls 用來上色（ok / warn / bad）
function scheduleStatus(p) {
  if (p.status === 'archived') return null;
  if (p.task_count === 0) return null;
  if (p.progress >= 100) return { cls: 'ok', text: '已完成' };
  if (p.end_date && p.end_date < today()) return { cls: 'bad', text: '已超過結束日' };
  const expected = expectedProgress(p);
  if (expected === null) return null;
  const diff = p.progress - expected;
  if (diff >= 0) return { cls: 'ok', text: diff > 0 ? `超前 ${diff}%` : '進度正常' };
  if (diff > -10) return { cls: 'warn', text: `落後 ${-diff}%` };
  return { cls: 'bad', text: `落後 ${-diff}%` };
}

function budgetStatus(p) {
  if (!p.budget) return p.spent ? { cls: 'warn', text: '未設定預算' } : null;
  const pct = Math.round((p.spent / p.budget) * 100);
  if (pct > 100) return { cls: 'bad', text: `超支 ${fmtMoney(p.spent - p.budget)}`, pct };
  if (pct >= 80) return { cls: 'warn', text: `已用 ${pct}%`, pct };
  return { cls: 'ok', text: `已用 ${pct}%`, pct };
}

function pill(s) {
  return s ? `<span class="pill ${s.cls}">${esc(s.text)}</span>` : '';
}

function progressHtml(p) {
  const expected = p.status === 'active' ? expectedProgress(p) : null;
  return `<div class="progress">
      <span data-pct="${p.progress}"></span>
      ${expected !== null && p.task_count ? `<i class="expected" data-left="${expected}" title="今天應達 ${expected}%"></i>` : ''}
    </div>
    <div class="progress-label"><span>進度 ${p.progress}%${expected !== null && p.task_count ? `（應達 ${expected}%）` : ''}</span>
      <span>${p.done_count} / ${p.task_count} 項完成</span></div>`;
}

function budgetBarHtml(spent, budget) {
  const pct = budget ? Math.round((spent / budget) * 100) : 0;
  const cls = pct > 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  return `<div class="progress budget ${cls}"><span data-pct="${pct}"></span></div>`;
}

function openDialog(html) {
  dialog.innerHTML = html;
  dialog.showModal();
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  return dialog;
}

function confirmDialog(message, { okText = '確定', danger = false } = {}) {
  return new Promise((resolve) => {
    openDialog(`<p>${esc(message)}</p>
      <div class="actions"><button type="button" data-close>取消</button>
      <button type="button" class="${danger ? 'danger' : 'primary'}" id="confirm-ok">${esc(okText)}</button></div>`);
    let ok = false;
    dialog.querySelector('#confirm-ok').addEventListener('click', () => { ok = true; dialog.close(); });
    dialog.addEventListener('close', () => resolve(ok), { once: true });
  });
}

async function getUsers(force = false) {
  if (!usersCache || force) usersCache = (await api('/users')).users;
  return usersCache;
}

function userName(u) {
  return u.display_name ? `${u.display_name}（${u.username}）` : u.username;
}

// ---------- 畫面：登入 ----------

function viewLogin() {
  topbar.hidden = true;
  app.innerHTML = `<form class="card auth" id="login-form" autocomplete="on">
    <h1>計劃管理</h1>
    <div class="field"><label for="username">帳號</label>
      <input id="username" name="username" autocomplete="username" autocapitalize="none" required></div>
    <div class="field"><label for="password">密碼</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <p class="error"></p>
    <button type="submit" class="primary full">登入</button>
  </form>`;
  const form = app.querySelector('form');
  bindForm(form, async (data) => {
    const res = await api('/auth/login', { method: 'POST', body: data });
    me = res.user;
    usersCache = null;
    go(me.must_change_password ? '#/password' : '#/dashboard');
  });
  form.username.focus();
}

// ---------- 畫面：修改密碼 ----------

function viewPassword() {
  const forced = me.must_change_password;
  topbar.hidden = forced;
  app.innerHTML = `<form class="card auth" id="pw-form">
    <h1>修改密碼</h1>
    ${forced ? '<div class="notice">這是第一次登入（或密碼剛被重設），請先設定新密碼才能繼續使用。</div>' : ''}
    <input type="text" name="username" value="${esc(me.username)}" autocomplete="username" hidden>
    <div class="field"><label for="cur">目前密碼</label>
      <input id="cur" name="current_password" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="new">新密碼</label>
      <input id="new" name="new_password" type="password" autocomplete="new-password" minlength="8" required>
      <div class="muted small">至少 8 個字元，需包含英文字母和數字</div></div>
    <div class="field"><label for="new2">再輸入一次新密碼</label>
      <input id="new2" name="confirm" type="password" autocomplete="new-password" required></div>
    <p class="error"></p>
    <div class="actions">
      ${forced ? '<button type="button" id="pw-logout">登出</button>' : '<a class="btn" href="#/dashboard">取消</a>'}
      <button type="submit" class="primary">儲存新密碼</button>
    </div>
  </form>`;
  const form = app.querySelector('form');
  bindForm(form, async (data) => {
    if (data.new_password !== data.confirm) throw new Error('兩次輸入的新密碼不一樣');
    const res = await api('/auth/change-password', {
      method: 'POST',
      body: { current_password: data.current_password, new_password: data.new_password },
    });
    me = res.user;
    toast('密碼已更新');
    go('#/dashboard');
  });
  app.querySelector('#pw-logout')?.addEventListener('click', logout);
  form.current_password.focus();
}

// ---------- 畫面：總覽 ----------

async function viewDashboard() {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const current = stillOn();
  const d = await api(`/dashboard?today=${today()}`);
  if (!current()) return;

  const projects = d.projects;
  const behind = projects.filter((p) => scheduleStatus(p)?.cls === 'bad').length;
  const overBudget = projects.filter((p) => budgetStatus(p)?.cls === 'bad').length;
  const totalBudget = projects.reduce((s, p) => s + (p.budget || 0), 0);
  const totalSpent = projects.reduce((s, p) => s + (p.spent || 0), 0);

  const taskRow = (t) => `<a class="list-row link-row" href="#/projects/${t.project_id}">
      <span class="title">${esc(t.title)}<span class="muted small"> · ${esc(t.project_name)}</span></span>
      <span class="info"><span class="badge ${t.priority}">${PRIORITY[t.priority]}</span>
        <span class="${t.due_date < d.today ? 'overdue' : ''}">📅 ${fmtDate(t.due_date)}</span>
        ${t.assignee_username ? `<span>👤 ${esc(t.assignee_name || t.assignee_username)}</span>` : ''}</span>
    </a>`;

  app.innerHTML = `<div class="toolbar"><h1>總覽</h1>
      <button type="button" class="primary" id="new-project">＋ 新增計劃</button></div>
    <div class="stats">
      <div class="card stat"><div class="label">進行中計劃</div><div class="value">${projects.length}</div></div>
      <div class="card stat"><div class="label">進度落後</div><div class="value ${behind ? 'bad' : ''}">${behind}</div></div>
      <div class="card stat"><div class="label">逾期任務</div><div class="value ${d.overdue_tasks.length ? 'bad' : ''}">${d.overdue_tasks.length}</div></div>
      <div class="card stat"><div class="label">預算使用</div><div class="value small-value">${fmtMoney(totalSpent)}<span class="muted"> / ${fmtMoney(totalBudget)}</span></div>
        ${overBudget ? `<div class="pill bad">${overBudget} 個計劃超支</div>` : ''}</div>
    </div>

    <h2 class="section-title">計劃狀況</h2>
    ${projects.length ? `<div class="card table-wrap"><table class="dash-table">
      <thead><tr><th>計劃</th><th>進度</th><th class="hide-mobile">時程</th><th>預算</th><th class="hide-mobile">下一個里程碑</th></tr></thead>
      <tbody>${projects.map((p) => {
        const b = budgetStatus(p);
        return `<tr>
          <td><a href="#/projects/${p.id}">${esc(p.name)}</a>${p.end_date ? `<div class="muted small">結束 ${fmtDate(p.end_date)}</div>` : ''}</td>
          <td class="cell-progress">${p.progress}%<div class="progress thin"><span data-pct="${p.progress}"></span></div></td>
          <td class="hide-mobile">${pill(scheduleStatus(p)) || '<span class="muted small">—</span>'}</td>
          <td>${p.budget ? `${fmtMoney(p.spent)}<div class="muted small">/ ${fmtMoney(p.budget)}</div>` : '<span class="muted small">未設定</span>'} ${b ? pill(b) : ''}</td>
          <td class="hide-mobile">${p.next_milestone_name ? `${esc(p.next_milestone_name)}<div class="small ${p.next_milestone_date < d.today ? 'overdue' : 'muted'}">${fmtDate(p.next_milestone_date)}</div>` : '<span class="muted small">—</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : '<div class="card empty">還沒有進行中的計劃。</div>'}

    <div class="two-col">
      <section>
        <h2 class="section-title">逾期任務 <span class="muted small">${d.overdue_tasks.length}</span></h2>
        ${d.overdue_tasks.length ? `<div class="list">${d.overdue_tasks.map(taskRow).join('')}</div>` : '<div class="card empty small">沒有逾期任務 👍</div>'}
        <h2 class="section-title">未來 7 天到期 <span class="muted small">${d.upcoming_tasks.length}</span></h2>
        ${d.upcoming_tasks.length ? `<div class="list">${d.upcoming_tasks.map(taskRow).join('')}</div>` : '<div class="card empty small">未來 7 天沒有到期的任務</div>'}
      </section>
      <section>
        <h2 class="section-title">里程碑（逾期與 30 天內）</h2>
        ${d.milestones.length ? `<div class="list">${d.milestones.map((m) => `<a class="list-row link-row" href="#/projects/${m.project_id}/milestones">
            <span class="title">🚩 ${esc(m.name)}<span class="muted small"> · ${esc(m.project_name)}</span></span>
            <span class="info"><span class="${m.due_date < d.today ? 'overdue' : ''}">${fmtDate(m.due_date)}${m.due_date < d.today ? ' 已逾期' : ''}</span></span>
          </a>`).join('')}</div>` : '<div class="card empty small">近期沒有里程碑</div>'}
      </section>
    </div>`;
  setProgress();
  app.querySelector('#new-project').addEventListener('click', () => projectDialog());
}

// ---------- 畫面：計劃列表 ----------

let projectFilter = 'active';

async function viewProjects() {
  app.innerHTML = `<div class="toolbar">
      <h1>計劃</h1>
      <div class="segmented" id="filter">
        <button type="button" data-v="active">進行中</button>
        <button type="button" data-v="archived">已封存</button>
      </div>
      <button type="button" class="primary" id="new-project">＋ 新增計劃</button>
    </div>
    <div id="projects"><p class="muted">載入中…</p></div>`;
  app.querySelectorAll('#filter button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === projectFilter);
    b.addEventListener('click', () => { projectFilter = b.dataset.v; viewProjects(); });
  });
  app.querySelector('#new-project').addEventListener('click', () => projectDialog());

  const current = stillOn();
  const { projects } = await api(`/projects?status=${projectFilter}`);
  if (!current()) return;
  const box = app.querySelector('#projects');
  if (!projects.length) {
    box.innerHTML = `<div class="card empty">${projectFilter === 'active' ? '還沒有計劃，按「新增計劃」開始吧。' : '沒有封存的計劃。'}</div>`;
    return;
  }
  box.innerHTML = `<div class="grid">${projects.map((p) => `
    <a class="card project-card" href="#/projects/${p.id}">
      <h2>${esc(p.name)}</h2>
      <p>${esc(p.description) || '（沒有說明）'}</p>
      ${progressHtml(p)}
      <div class="card-pills">${pill(scheduleStatus(p))}${pill(budgetStatus(p))}</div>
      ${p.end_date ? `<div class="small muted">結束日 <span class="${p.end_date < today() && p.status === 'active' && p.progress < 100 ? 'overdue' : ''}">${fmtDate(p.end_date)}</span></div>` : ''}
    </a>`).join('')}</div>`;
  setProgress();
}

function projectDialog(project) {
  const p = project || {};
  const canBudget = !project || project.can_edit_budget;
  openDialog(`<form method="dialog" id="project-form">
    <h2>${project ? '編輯計劃' : '新增計劃'}</h2>
    <div class="field"><label>計劃名稱</label><input name="name" maxlength="100" required value="${esc(p.name)}"></div>
    <div class="field"><label>說明</label><textarea name="description" maxlength="2000">${esc(p.description)}</textarea></div>
    <div class="row">
      <div class="field"><label>開始日</label><input type="date" name="start_date" value="${esc(p.start_date)}"></div>
      <div class="field"><label>結束日</label><input type="date" name="end_date" value="${esc(p.end_date)}"></div>
    </div>
    ${canBudget ? `<div class="field"><label>總預算（新台幣）</label>
      <input type="number" name="budget" min="0" step="1" inputmode="numeric" value="${p.budget || ''}" placeholder="0"></div>` : ''}
    <p class="muted small">設定開始日和結束日後，系統會自動判斷進度是否落後。</p>
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    if (canBudget) data.budget = data.budget === '' ? 0 : Number(data.budget);
    const res = project
      ? await api(`/projects/${project.id}`, { method: 'PATCH', body: data })
      : await api('/projects', { method: 'POST', body: data });
    dialog.close();
    toast('已儲存');
    if (location.hash === `#/projects/${res.project.id}`) render();
    else go(`#/projects/${res.project.id}`);
  });
  form.name.focus();
}

// ---------- 畫面：計劃內容（任務／預算／里程碑） ----------

let taskView = localStorageGet('taskView') || 'board';

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 無法儲存時忽略 */ }
}

const PROJECT_TABS = { tasks: '任務', budget: '預算', milestones: '里程碑' };

async function viewProject(projectId, tab = 'tasks') {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const current = stillOn();
  const { project } = await api(`/projects/${projectId}`);
  if (!current()) return;
  const archived = project.status === 'archived';
  const sched = scheduleStatus(project);
  const bstat = budgetStatus(project);

  app.innerHTML = `<div class="project-head">
      <div class="toolbar">
        <h1>${esc(project.name)} ${archived ? '<span class="badge">已封存</span>' : ''}</h1>
        <div class="actions">
          <button type="button" id="edit-project">編輯</button>
          <button type="button" id="archive-project">${archived ? '取消封存' : '封存'}</button>
          <button type="button" class="danger" id="delete-project">刪除</button>
        </div>
      </div>
      ${project.description ? `<div class="desc">${esc(project.description)}</div>` : ''}
      <div class="meta">
        ${project.start_date && project.end_date ? `<span>期間 ${fmtDate(project.start_date)} ～ ${fmtDate(project.end_date)}</span>`
          : project.end_date ? `<span>結束日 ${fmtDate(project.end_date)}</span>`
          : project.start_date ? `<span>開始日 ${fmtDate(project.start_date)}</span>` : ''}
        ${project.owner_username ? `<span>建立者 ${esc(project.owner_username)}</span>` : ''}
      </div>
      <div class="summary">
        <div class="card summary-item">
          <div class="label">進度 ${pill(sched)}</div>
          ${progressHtml(project)}
        </div>
        <div class="card summary-item">
          <div class="label">預算 ${pill(bstat)}</div>
          ${project.budget ? `${budgetBarHtml(project.spent, project.budget)}
            <div class="progress-label"><span>已用 ${fmtMoney(project.spent)}</span><span>剩餘 ${fmtMoney(project.budget - project.spent)}</span></div>`
            : `<div class="muted small">${project.spent ? `已支出 ${fmtMoney(project.spent)}，` : ''}尚未設定總預算</div>`}
        </div>
        <div class="card summary-item">
          <div class="label">里程碑 <span class="muted small">${project.milestone_done} / ${project.milestone_count}</span></div>
          ${project.next_milestone_name
            ? `<div>🚩 ${esc(project.next_milestone_name)}</div><div class="small ${project.next_milestone_date < today() ? 'overdue' : 'muted'}">${fmtDate(project.next_milestone_date)}${project.next_milestone_date < today() ? ' 已逾期' : ''}</div>`
            : `<div class="muted small">${project.milestone_count ? '全部完成' : '尚未設定'}</div>`}
        </div>
      </div>
    </div>
    <nav class="tabs">${Object.entries(PROJECT_TABS).map(([k, v]) =>
      `<a href="#/projects/${project.id}${k === 'tasks' ? '' : '/' + k}" class="${k === tab ? 'on' : ''}">${v}</a>`).join('')}</nav>
    <div id="tab"><p class="muted">載入中…</p></div>`;
  setProgress();

  app.querySelector('#edit-project').addEventListener('click', () => projectDialog(project));
  app.querySelector('#archive-project').addEventListener('click', async () => {
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { status: archived ? 'active' : 'archived' } });
      toast(archived ? '已取消封存' : '已封存');
      render();
    } catch (e) { toast(e.message); }
  });
  app.querySelector('#delete-project').addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除「${project.name}」和裡面所有的任務、預算、支出和里程碑嗎？刪除後無法復原。`, { okText: '刪除', danger: true });
    if (!ok) return;
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      toast('已刪除');
      go('#/projects');
    } catch (e) { toast(e.message); }
  });

  const box = app.querySelector('#tab');
  if (tab === 'budget') await drawBudget(box, project, current);
  else if (tab === 'milestones') await drawMilestones(box, project, current);
  else await drawTasks(box, project, current);
}

// ----- 任務分頁 -----

async function drawTasks(box, project, current) {
  const { tasks } = await api(`/projects/${project.id}/tasks`);
  if (!current()) return;
  box.innerHTML = `<div class="toolbar">
      <div class="segmented" id="view-toggle">
        <button type="button" data-v="board">看板</button>
        <button type="button" data-v="list">清單</button>
      </div>
      <button type="button" class="primary" id="new-task">＋ 新增任務</button>
    </div>
    <div id="tasks"></div>`;
  box.querySelector('#new-task').addEventListener('click', () => taskDialog(project.id));
  const draw = () => {
    box.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === taskView));
    const el = box.querySelector('#tasks');
    if (taskView === 'list') drawList(el, tasks, render);
    else drawBoard(el, project.id, tasks, render);
  };
  box.querySelectorAll('#view-toggle button').forEach((b) => {
    b.addEventListener('click', () => { taskView = b.dataset.v; localStorageSet('taskView', taskView); draw(); });
  });
  draw();
}

function taskInfo(t) {
  const overdue = t.due_date && t.status !== 'done' && t.due_date < today();
  return `<span class="badge ${t.priority}">${PRIORITY[t.priority]}</span>
    ${t.status === 'doing' || (t.progress > 0 && t.status !== 'done') ? `<span class="badge">${t.progress}%</span>` : ''}
    ${t.weight !== 1 ? `<span title="權重">⚖️ ${t.weight}</span>` : ''}
    ${t.due_date ? `<span class="${overdue ? 'overdue' : ''}">📅 ${fmtDate(t.due_date)}</span>` : ''}
    ${t.assignee_username ? `<span>👤 ${esc(t.assignee_name || t.assignee_username)}</span>` : ''}`;
}

function drawBoard(box, projectId, tasks, refresh) {
  const order = ['todo', 'doing', 'done'];
  box.innerHTML = `<div class="board">${order.map((s, i) => {
    const list = tasks.filter((t) => t.status === s);
    return `<section class="column" data-status="${s}">
      <div class="column-head"><span>${STATUS[s]}</span><span class="count">${list.length}</span></div>
      ${list.map((t) => `<div class="task-card" draggable="true" data-id="${t.id}">
        <div class="title">${esc(t.title)}</div>
        ${s === 'doing' ? `<div class="progress thin"><span data-pct="${t.progress}"></span></div>` : ''}
        <div class="info">${taskInfo(t)}
          <span class="move">
            ${i > 0 ? `<button type="button" class="small" data-move="${order[i - 1]}" title="移到${STATUS[order[i - 1]]}">←</button>` : ''}
            ${i < 2 ? `<button type="button" class="small" data-move="${order[i + 1]}" title="移到${STATUS[order[i + 1]]}">→</button>` : ''}
          </span>
        </div>
      </div>`).join('')}
      <button type="button" class="add-task" data-add="${s}">＋ 新增</button>
    </section>`;
  }).join('')}</div>`;
  setProgress(box);

  const byId = (taskId) => tasks.find((t) => t.id === Number(taskId));
  const move = async (taskId, status) => {
    try {
      await api(`/tasks/${taskId}`, { method: 'PATCH', body: { status } });
      refresh();
    } catch (e) { toast(e.message); }
  };

  box.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      const moveBtn = e.target.closest('[data-move]');
      if (moveBtn) { e.stopPropagation(); move(card.dataset.id, moveBtn.dataset.move); return; }
      taskDialog(projectId, byId(card.dataset.id));
    });
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  box.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const taskId = e.dataTransfer.getData('text/plain');
      const task = byId(taskId);
      if (task && task.status !== col.dataset.status) move(taskId, col.dataset.status);
    });
  });
  box.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => taskDialog(projectId, null, b.dataset.add)));
}

function drawList(box, tasks, refresh) {
  if (!tasks.length) {
    box.innerHTML = '<div class="card empty">還沒有任務，按「新增任務」開始吧。</div>';
    return;
  }
  // 未完成的在前，依截止日排序（沒有截止日的放後面）
  const sorted = [...tasks].sort((a, b) =>
    (a.status === 'done') - (b.status === 'done') ||
    (a.due_date || '9999').localeCompare(b.due_date || '9999') ||
    a.id - b.id);
  box.innerHTML = `<div class="list">${sorted.map((t) => `
    <div class="list-row ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} aria-label="標記完成">
      <span class="title">${esc(t.title)}</span>
      <span class="info"><span class="badge">${STATUS[t.status]}</span>${taskInfo(t)}</span>
    </div>`).join('')}</div>`;
  box.querySelectorAll('.list-row').forEach((row) => {
    const task = tasks.find((t) => t.id === Number(row.dataset.id));
    row.querySelector('input').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'todo' } });
        refresh();
      } catch (err) { toast(err.message); }
    });
    row.addEventListener('click', () => taskDialog(task.project_id, task));
  });
}

async function taskDialog(projectId, task, status = 'todo') {
  const t = task || { status, priority: 'medium', progress: status === 'done' ? 100 : 0, weight: 1 };
  const users = await getUsers().catch(() => []);
  openDialog(`<form method="dialog" id="task-form">
    <h2>${task ? '編輯任務' : '新增任務'}</h2>
    <div class="field"><label>任務名稱</label><input name="title" maxlength="200" required value="${esc(t.title)}"></div>
    <div class="field"><label>說明</label><textarea name="description" maxlength="5000">${esc(t.description)}</textarea></div>
    <div class="row">
      <div class="field"><label>狀態</label><select name="status">
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div class="field"><label>優先度</label><select name="priority">
        ${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
    </div>
    <div class="row">
      <div class="field"><label>進度 <output id="progress-out">${t.progress}%</output></label>
        <input type="range" name="progress" min="0" max="100" step="5" value="${t.progress}"></div>
      <div class="field"><label>權重</label>
        <input type="number" name="weight" min="0.1" max="1000" step="0.1" inputmode="decimal" value="${t.weight}">
        <div class="muted small">越重要或越花時間的任務設越大，預設 1</div></div>
    </div>
    <div class="row">
      <div class="field"><label>截止日</label><input type="date" name="due_date" value="${esc(t.due_date)}"></div>
      <div class="field"><label>負責人</label><select name="assignee_id">
        <option value="">（未指定）</option>
        ${users.filter((u) => !u.disabled || u.id === t.assignee_id).map((u) => `<option value="${u.id}" ${t.assignee_id === u.id ? 'selected' : ''}>${esc(userName(u))}</option>`).join('')}
      </select></div>
    </div>
    <p class="error"></p>
    <div class="actions">
      ${task ? '<button type="button" class="danger" id="delete-task">刪除</button>' : ''}
      <button type="button" data-close>取消</button>
      <button type="submit" class="primary">儲存</button>
    </div>
  </form>`);
  const form = dialog.querySelector('form');
  const out = form.querySelector('#progress-out');
  // 進度和狀態連動：拉到 100% 就是完成，選完成就是 100%
  form.progress.addEventListener('input', () => {
    const v = Number(form.progress.value);
    out.textContent = v + '%';
    if (v === 100) form.status.value = 'done';
    else if (form.status.value === 'done') form.status.value = v > 0 ? 'doing' : 'todo';
    else if (v > 0 && form.status.value === 'todo') form.status.value = 'doing';
  });
  form.status.addEventListener('change', () => {
    if (form.status.value === 'done') form.progress.value = 100;
    else if (Number(form.progress.value) === 100) form.progress.value = 0;
    out.textContent = form.progress.value + '%';
  });
  bindForm(form, async (data) => {
    data.progress = Number(data.progress);
    data.weight = Number(data.weight || 1);
    if (task) await api(`/tasks/${task.id}`, { method: 'PATCH', body: data });
    else await api(`/projects/${projectId}/tasks`, { method: 'POST', body: data });
    dialog.close();
    toast('已儲存');
    render();
  });
  dialog.querySelector('#delete-task')?.addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除任務「${task.title}」嗎？`, { okText: '刪除', danger: true });
    if (!ok) return;
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      toast('已刪除');
      render();
    } catch (e) { toast(e.message); }
  });
  if (!task) form.title.focus();
}

// ----- 預算分頁 -----

async function drawBudget(box, project, current) {
  const [b, { tasks }] = await Promise.all([
    api(`/projects/${project.id}/budget`),
    api(`/projects/${project.id}/tasks`),
  ]);
  if (!current()) return;
  const planned = b.items.reduce((s, i) => s + i.planned_amount, 0);
  const unassignedSpent = b.spent - b.items.reduce((s, i) => s + i.spent, 0);
  const remaining = b.budget - b.spent;
  const usedPct = b.budget ? Math.round((b.spent / b.budget) * 100) : null;

  box.innerHTML = `
    ${b.can_edit ? '' : '<div class="notice">你可以查看預算；只有管理員或計劃建立者可以修改。</div>'}
    <div class="stats">
      <div class="card stat"><div class="label">總預算</div><div class="value small-value">${fmtMoney(b.budget)}</div>
        ${b.can_edit ? '<button type="button" class="link edit-link" id="edit-budget">修改</button>' : ''}</div>
      <div class="card stat"><div class="label">已支出</div><div class="value small-value">${fmtMoney(b.spent)}</div></div>
      <div class="card stat"><div class="label">剩餘</div><div class="value small-value ${remaining < 0 ? 'bad' : ''}">${fmtMoney(remaining)}</div></div>
      <div class="card stat"><div class="label">使用率</div><div class="value small-value ${usedPct > 100 ? 'bad' : usedPct >= 80 ? 'warn' : ''}">${usedPct === null ? '—' : usedPct + '%'}</div></div>
    </div>
    ${b.budget ? budgetBarHtml(b.spent, b.budget) : ''}

    <div class="toolbar section-gap"><h2>預算科目</h2>
      ${b.can_edit ? '<button type="button" id="new-item">＋ 新增科目</button>' : ''}</div>
    ${b.items.length || unassignedSpent ? `<div class="card table-wrap"><table>
      <thead><tr><th>科目</th><th class="num">預計</th><th class="num">已支出</th><th class="num hide-mobile">剩餘</th><th class="hide-mobile">使用</th>${b.can_edit ? '<th></th>' : ''}</tr></thead>
      <tbody>
        ${b.items.map((i) => {
          const left = i.planned_amount - i.spent;
          return `<tr data-id="${i.id}">
            <td>${esc(i.name)}</td>
            <td class="num">${fmtMoney(i.planned_amount)}</td>
            <td class="num">${fmtMoney(i.spent)}</td>
            <td class="num hide-mobile ${left < 0 ? 'overdue' : ''}">${fmtMoney(left)}</td>
            <td class="hide-mobile cell-progress">${i.planned_amount ? budgetBarHtml(i.spent, i.planned_amount) : ''}</td>
            ${b.can_edit ? '<td><button type="button" class="small" data-edit-item>編輯</button></td>' : ''}
          </tr>`;
        }).join('')}
        ${unassignedSpent ? `<tr><td class="muted">未分類</td><td class="num muted">—</td><td class="num">${fmtMoney(unassignedSpent)}</td><td class="hide-mobile"></td><td class="hide-mobile"></td>${b.can_edit ? '<td></td>' : ''}</tr>` : ''}
      </tbody>
      <tfoot><tr><th>合計</th><th class="num">${fmtMoney(planned)}</th><th class="num">${fmtMoney(b.spent)}</th><th class="hide-mobile"></th><th class="hide-mobile"></th>${b.can_edit ? '<th></th>' : ''}</tr></tfoot>
    </table></div>
    ${b.budget && planned !== b.budget ? `<p class="muted small">科目預計合計 ${fmtMoney(planned)}，${planned > b.budget ? `超過總預算 ${fmtMoney(planned - b.budget)}` : `尚有 ${fmtMoney(b.budget - planned)} 未分配到科目`}。</p>` : ''}`
    : `<div class="card empty small">還沒有預算科目${b.can_edit ? '，可以依人力、設備、外包等分類建立' : ''}。</div>`}

    <div class="toolbar section-gap"><h2>支出紀錄</h2>
      ${b.can_edit ? '<button type="button" class="primary" id="new-expense">＋ 記一筆</button>' : ''}</div>
    ${b.expenses.length ? `<div class="list">${b.expenses.map((e) => `
      <div class="list-row ${b.can_edit ? '' : 'static'}" data-id="${e.id}">
        <span class="title">${esc(e.description) || '<span class="muted">（無說明）</span>'}
          <span class="muted small"> · ${esc(e.budget_item_name || '未分類')}${e.task_title ? ` · ${esc(e.task_title)}` : ''}</span></span>
        <span class="info"><span>${fmtDate(e.spent_on)}</span><b class="amount">${fmtMoney(e.amount)}</b></span>
      </div>`).join('')}</div>` : '<div class="card empty small">還沒有支出紀錄。</div>'}`;
  setProgress(box);

  if (!b.can_edit) return;
  box.querySelector('#edit-budget').addEventListener('click', () => budgetTotalDialog(project, b.budget));
  box.querySelector('#new-item').addEventListener('click', () => budgetItemDialog(project));
  box.querySelectorAll('[data-edit-item]').forEach((btn) => btn.addEventListener('click', () => {
    budgetItemDialog(project, b.items.find((i) => i.id === Number(btn.closest('tr').dataset.id)));
  }));
  box.querySelector('#new-expense').addEventListener('click', () => expenseDialog(project, b.items, tasks));
  box.querySelectorAll('.list-row[data-id]').forEach((row) => row.addEventListener('click', () => {
    expenseDialog(project, b.items, tasks, b.expenses.find((e) => e.id === Number(row.dataset.id)));
  }));
}

function budgetTotalDialog(project, budget) {
  openDialog(`<form method="dialog">
    <h2>總預算</h2>
    <div class="field"><label>總預算（新台幣）</label>
      <input type="number" name="budget" min="0" step="1" inputmode="numeric" value="${budget || ''}" required></div>
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    await api(`/projects/${project.id}`, { method: 'PATCH', body: { budget: Number(data.budget) } });
    dialog.close();
    toast('已儲存');
    render();
  });
  form.budget.focus();
}

function budgetItemDialog(project, item) {
  const i = item || {};
  openDialog(`<form method="dialog">
    <h2>${item ? '編輯預算科目' : '新增預算科目'}</h2>
    <div class="field"><label>科目名稱</label><input name="name" maxlength="50" required value="${esc(i.name)}" list="item-suggestions">
      <datalist id="item-suggestions"><option value="人力"><option value="設備"><option value="外包"><option value="差旅"><option value="行銷"><option value="雜支"></datalist></div>
    <div class="field"><label>預計金額（新台幣）</label>
      <input type="number" name="planned_amount" min="0" step="1" inputmode="numeric" value="${i.planned_amount ?? ''}" placeholder="0"></div>
    <p class="error"></p>
    <div class="actions">
      ${item ? '<button type="button" class="danger" id="delete-item">刪除</button>' : ''}
      <button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button>
    </div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    const body = { name: data.name, planned_amount: data.planned_amount === '' ? 0 : Number(data.planned_amount) };
    if (item) await api(`/budget-items/${item.id}`, { method: 'PATCH', body });
    else await api(`/projects/${project.id}/budget-items`, { method: 'POST', body });
    dialog.close();
    toast('已儲存');
    render();
  });
  dialog.querySelector('#delete-item')?.addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除科目「${item.name}」嗎？已登記的支出會保留並改為「未分類」。`, { okText: '刪除', danger: true });
    if (!ok) return;
    try {
      await api(`/budget-items/${item.id}`, { method: 'DELETE' });
      toast('已刪除');
      render();
    } catch (e) { toast(e.message); }
  });
  form.name.focus();
}

function expenseDialog(project, items, tasks, expense) {
  const e = expense || { spent_on: today() };
  openDialog(`<form method="dialog">
    <h2>${expense ? '編輯支出' : '記一筆支出'}</h2>
    <div class="row">
      <div class="field"><label>日期</label><input type="date" name="spent_on" required value="${esc(e.spent_on)}"></div>
      <div class="field"><label>金額（新台幣）</label><input type="number" name="amount" min="1" step="1" inputmode="numeric" required value="${e.amount ?? ''}"></div>
    </div>
    <div class="field"><label>說明</label><input name="description" maxlength="500" value="${esc(e.description)}" placeholder="例如：購買筆電"></div>
    <div class="row">
      <div class="field"><label>預算科目</label><select name="budget_item_id">
        <option value="">（未分類）</option>
        ${items.map((i) => `<option value="${i.id}" ${e.budget_item_id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
      </select></div>
      <div class="field"><label>關聯任務（選填）</label><select name="task_id">
        <option value="">（無）</option>
        ${tasks.map((t) => `<option value="${t.id}" ${e.task_id === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}
      </select></div>
    </div>
    <p class="error"></p>
    <div class="actions">
      ${expense ? '<button type="button" class="danger" id="delete-expense">刪除</button>' : ''}
      <button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button>
    </div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    const body = { ...data, amount: Number(data.amount) };
    if (expense) await api(`/expenses/${expense.id}`, { method: 'PATCH', body });
    else await api(`/projects/${project.id}/expenses`, { method: 'POST', body });
    dialog.close();
    toast('已儲存');
    render();
  });
  dialog.querySelector('#delete-expense')?.addEventListener('click', async () => {
    const ok = await confirmDialog('確定要刪除這筆支出嗎？', { okText: '刪除', danger: true });
    if (!ok) return;
    try {
      await api(`/expenses/${expense.id}`, { method: 'DELETE' });
      toast('已刪除');
      render();
    } catch (err) { toast(err.message); }
  });
  if (!expense) form.amount.focus();
}

// ----- 里程碑分頁 -----

async function drawMilestones(box, project, current) {
  const { milestones } = await api(`/projects/${project.id}/milestones`);
  if (!current()) return;
  const t = today();
  box.innerHTML = `<div class="toolbar"><span class="muted small">重要的日期節點，例如「設計定稿」、「正式上線」。到期還沒完成會標紅。</span>
      <button type="button" class="primary" id="new-milestone">＋ 新增里程碑</button></div>
    ${milestones.length ? `<div class="list timeline">${milestones.map((m) => {
      const state = m.done ? ['ok', '已完成'] : m.due_date < t ? ['bad', `逾期 ${dayNumber(t) - dayNumber(m.due_date)} 天`]
        : ['', dayNumber(m.due_date) === dayNumber(t) ? '今天' : `還有 ${dayNumber(m.due_date) - dayNumber(t)} 天`];
      return `<div class="list-row ${m.done ? 'done' : ''}" data-id="${m.id}">
        <input type="checkbox" ${m.done ? 'checked' : ''} aria-label="標記完成">
        <span class="title">🚩 ${esc(m.name)}</span>
        <span class="info"><span>${fmtDate(m.due_date)}</span>${state[0] ? pill({ cls: state[0], text: state[1] }) : `<span class="muted">${state[1]}</span>`}</span>
      </div>`;
    }).join('')}</div>` : '<div class="card empty">還沒有里程碑。</div>'}`;
  box.querySelector('#new-milestone').addEventListener('click', () => milestoneDialog(project));
  box.querySelectorAll('.list-row').forEach((row) => {
    const m = milestones.find((x) => x.id === Number(row.dataset.id));
    row.querySelector('input').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(`/milestones/${m.id}`, { method: 'PATCH', body: { done: e.target.checked } });
        render();
      } catch (err) { toast(err.message); }
    });
    row.addEventListener('click', () => milestoneDialog(project, m));
  });
}

function milestoneDialog(project, milestone) {
  const m = milestone || {};
  openDialog(`<form method="dialog">
    <h2>${milestone ? '編輯里程碑' : '新增里程碑'}</h2>
    <div class="field"><label>名稱</label><input name="name" maxlength="100" required value="${esc(m.name)}"></div>
    <div class="field"><label>日期</label><input type="date" name="due_date" required value="${esc(m.due_date)}"></div>
    <p class="error"></p>
    <div class="actions">
      ${milestone ? '<button type="button" class="danger" id="delete-milestone">刪除</button>' : ''}
      <button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button>
    </div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    if (milestone) await api(`/milestones/${milestone.id}`, { method: 'PATCH', body: data });
    else await api(`/projects/${project.id}/milestones`, { method: 'POST', body: data });
    dialog.close();
    toast('已儲存');
    render();
  });
  dialog.querySelector('#delete-milestone')?.addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除里程碑「${milestone.name}」嗎？`, { okText: '刪除', danger: true });
    if (!ok) return;
    try {
      await api(`/milestones/${milestone.id}`, { method: 'DELETE' });
      toast('已刪除');
      render();
    } catch (e) { toast(e.message); }
  });
  form.name.focus();
}

// ---------- 畫面：使用者管理（管理員） ----------

async function viewUsers() {
  if (me.role !== 'admin') { go('#/projects'); return; }
  app.innerHTML = `<div class="toolbar"><h1>使用者</h1>
    <button type="button" class="primary" id="new-user">＋ 新增使用者</button></div>
    <div class="card table-wrap" id="users"><p class="muted">載入中…</p></div>`;
  app.querySelector('#new-user').addEventListener('click', newUserDialog);

  const current = stillOn();
  const users = await getUsers(true);
  if (!current()) return;
  const box = app.querySelector('#users');
  box.innerHTML = `<table>
    <thead><tr><th>帳號</th><th class="hide-mobile">顯示名稱</th><th>角色</th><th>狀態</th><th></th></tr></thead>
    <tbody>${users.map((u) => {
      const self = u.id === me.id;
      const state = u.disabled ? '已停用' : u.locked_until && u.locked_until > Date.now() ? '暫時鎖定' : u.must_change_password ? '待改密碼' : '正常';
      return `<tr data-id="${u.id}">
        <td>${esc(u.username)}${self ? ' <span class="badge">你</span>' : ''}</td>
        <td class="hide-mobile">${esc(u.display_name)}</td>
        <td>${u.role === 'admin' ? '管理員' : '成員'}</td>
        <td>${state}</td>
        <td><div class="actions">
          <button type="button" class="small" data-act="reset">重設密碼</button>
          ${self ? '' : `<button type="button" class="small" data-act="role">${u.role === 'admin' ? '改為成員' : '設為管理員'}</button>
          <button type="button" class="small ${u.disabled ? '' : 'danger'}" data-act="toggle">${u.disabled ? '啟用' : '停用'}</button>`}
        </div></td></tr>`;
    }).join('')}</tbody></table>`;

  box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const u = users.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    try {
      if (btn.dataset.act === 'reset') {
        resetPasswordDialog(u);
      } else if (btn.dataset.act === 'role') {
        await api(`/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } });
        viewUsers();
      } else {
        if (!u.disabled && !(await confirmDialog(`確定要停用 ${u.username} 嗎？對方會立刻被登出。`, { okText: '停用', danger: true }))) return;
        await api(`/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
        viewUsers();
      }
    } catch (e) { toast(e.message); }
  }));
}

function newUserDialog() {
  openDialog(`<form method="dialog">
    <h2>新增使用者</h2>
    <div class="field"><label>帳號</label><input name="username" autocapitalize="none" pattern="[A-Za-z0-9_.\\-]{3,32}" required>
      <div class="muted small">英文、數字、底線、點或減號，3 到 32 個字</div></div>
    <div class="field"><label>顯示名稱（選填）</label><input name="display_name" maxlength="50"></div>
    <div class="field"><label>角色</label><select name="role"><option value="member">成員</option><option value="admin">管理員</option></select></div>
    ${passwordField()}
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">建立</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    await api('/users', { method: 'POST', body: data });
    usersCache = null;
    dialog.close();
    toast(`已建立 ${data.username}，初始密碼${data.password ? '為你設定的密碼' : '為 123456'}`);
    render();
  });
  form.username.focus();
}

function passwordField() {
  return `<div class="field"><label>初始密碼（選填）</label>
      <input name="password" type="text" autocomplete="off" autocapitalize="none" minlength="6" maxlength="128" placeholder="留白則為 123456">
      <div class="muted small">對方第一次登入後會被要求改成自己的密碼</div></div>`;
}

function resetPasswordDialog(u) {
  const self = u.id === me.id;
  openDialog(`<form method="dialog">
    <h2>重設 ${esc(u.username)} 的密碼</h2>
    ${passwordField()}
    ${self ? '<p class="notice">你正在重設自己的密碼，完成後需要重新登入。</p>' : '<p class="muted small">重設後對方會被登出，需要用新密碼重新登入。</p>'}
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">重設密碼</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    await api(`/users/${u.id}/reset-password`, { method: 'POST', body: data });
    dialog.close();
    toast(`已重設 ${u.username} 的密碼${data.password ? '' : '為 123456'}`);
    if (self) { me = null; go('#/login'); } else render();
  });
  form.password.focus();
}

// ---------- 路由 ----------

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* 已登出 */ }
  me = null;
  usersCache = null;
  go('#/login');
}

async function render() {
  if (dialog.open) dialog.close();
  const hash = location.hash && location.hash !== '#/' ? location.hash : '#/dashboard';
  if (!me && hash !== '#/login') {
    try {
      me = (await api('/auth/me')).user;
    } catch {
      return;
    }
  }
  if (hash === '#/login') {
    if (me) return go('#/dashboard');
    return viewLogin();
  }
  if (me.must_change_password && hash !== '#/password') return go('#/password');

  topbar.hidden = false;
  document.getElementById('nav-users').hidden = me.role !== 'admin';
  const section = hash.split('/')[1];
  topbar.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));

  try {
    const m = hash.match(/^#\/projects\/(\d+)(?:\/(budget|milestones))?$/);
    if (hash === '#/password') viewPassword();
    else if (hash === '#/users') await viewUsers();
    else if (hash === '#/projects') await viewProjects();
    else if (m) await viewProject(Number(m[1]), m[2] || 'tasks');
    else await viewDashboard();
  } catch (e) {
    if (me) app.innerHTML = `<div class="card empty">${esc(e.message)}<br><br><a href="#/dashboard">回到總覽</a></div>`;
  }
}

document.getElementById('logout').addEventListener('click', logout);
window.addEventListener('hashchange', render);
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
