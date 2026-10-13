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
  root.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = el.dataset.pct + '%'; });
}

function progressHtml(p) {
  const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
  return `<div class="progress"><span data-pct="${pct}"></span></div>
    <div class="progress-label"><span>${p.done_count} / ${p.task_count} 項完成</span><span>${pct}%</span></div>`;
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
    go(me.must_change_password ? '#/password' : '#/projects');
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
      ${forced ? '<button type="button" id="pw-logout">登出</button>' : '<a class="btn" href="#/projects">取消</a>'}
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
    go('#/projects');
  });
  app.querySelector('#pw-logout')?.addEventListener('click', logout);
  form.current_password.focus();
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
      ${p.end_date ? `<div class="small muted">結束日 <span class="${p.end_date < today() && p.status === 'active' ? 'overdue' : ''}">${fmtDate(p.end_date)}</span></div>` : ''}
    </a>`).join('')}</div>`;
  setProgress();
}

function projectDialog(project) {
  const p = project || {};
  openDialog(`<form method="dialog" id="project-form">
    <h2>${project ? '編輯計劃' : '新增計劃'}</h2>
    <div class="field"><label>計劃名稱</label><input name="name" maxlength="100" required value="${esc(p.name)}"></div>
    <div class="field"><label>說明</label><textarea name="description" maxlength="2000">${esc(p.description)}</textarea></div>
    <div class="row">
      <div class="field"><label>開始日</label><input type="date" name="start_date" value="${esc(p.start_date)}"></div>
      <div class="field"><label>結束日</label><input type="date" name="end_date" value="${esc(p.end_date)}"></div>
    </div>
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">儲存</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    const res = project
      ? await api(`/projects/${project.id}`, { method: 'PATCH', body: data })
      : await api('/projects', { method: 'POST', body: data });
    dialog.close();
    toast('已儲存');
    go(`#/projects/${res.project.id}`);
  });
  form.name.focus();
}

// ---------- 畫面：計劃內容（看板／清單） ----------

let taskView = localStorageGet('taskView') || 'board';

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 無法儲存時忽略 */ }
}

async function viewProject(projectId) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const current = stillOn();
  const [{ project }, { tasks }] = await Promise.all([
    api(`/projects/${projectId}`),
    api(`/projects/${projectId}/tasks`),
  ]);
  if (!current()) return;
  const archived = project.status === 'archived';
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
      ${progressHtml(project)}
    </div>
    <div class="toolbar">
      <div class="segmented" id="view-toggle">
        <button type="button" data-v="board">看板</button>
        <button type="button" data-v="list">清單</button>
      </div>
      <button type="button" class="primary" id="new-task">＋ 新增任務</button>
    </div>
    <div id="tasks"></div>`;
  setProgress();

  app.querySelector('#edit-project').addEventListener('click', () => projectDialog(project));
  app.querySelector('#archive-project').addEventListener('click', async () => {
    await api(`/projects/${project.id}`, { method: 'PATCH', body: { status: archived ? 'active' : 'archived' } });
    toast(archived ? '已取消封存' : '已封存');
    viewProject(project.id);
  });
  app.querySelector('#delete-project').addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除「${project.name}」和裡面的 ${project.task_count} 個任務嗎？刪除後無法復原。`, { okText: '刪除', danger: true });
    if (!ok) return;
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    toast('已刪除');
    go('#/projects');
  });
  app.querySelector('#new-task').addEventListener('click', () => taskDialog(project.id));
  app.querySelectorAll('#view-toggle button').forEach((b) => {
    b.addEventListener('click', () => { taskView = b.dataset.v; localStorageSet('taskView', taskView); drawTasks(); });
  });

  const refresh = () => viewProject(project.id);

  function drawTasks() {
    app.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === taskView));
    const box = app.querySelector('#tasks');
    if (taskView === 'list') drawList(box, tasks, refresh);
    else drawBoard(box, project.id, tasks, refresh);
  }
  drawTasks();
}

function taskInfo(t) {
  const overdue = t.due_date && t.status !== 'done' && t.due_date < today();
  return `<span class="badge ${t.priority}">${PRIORITY[t.priority]}</span>
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
  const t = task || { status, priority: 'medium' };
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
  bindForm(form, async (data) => {
    if (task) await api(`/tasks/${task.id}`, { method: 'PATCH', body: data });
    else await api(`/projects/${projectId}/tasks`, { method: 'POST', body: data });
    dialog.close();
    toast('已儲存');
    viewProject(projectId);
  });
  dialog.querySelector('#delete-task')?.addEventListener('click', async () => {
    const ok = await confirmDialog(`確定要刪除任務「${task.title}」嗎？`, { okText: '刪除', danger: true });
    if (!ok) return;
    await api(`/tasks/${task.id}`, { method: 'DELETE' });
    toast('已刪除');
    viewProject(projectId);
  });
  if (!task) form.title.focus();
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
        if (!(await confirmDialog(`要重設 ${u.username} 的密碼嗎？對方需要用臨時密碼重新登入。`))) return;
        const res = await api(`/users/${u.id}/reset-password`, { method: 'POST', body: {} });
        showTempPassword(u.username, res.temp_password);
        if (u.id === me.id) { me = null; }
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
    <p class="error"></p>
    <div class="actions"><button type="button" data-close>取消</button><button type="submit" class="primary">建立</button></div>
  </form>`);
  const form = dialog.querySelector('form');
  bindForm(form, async (data) => {
    const res = await api('/users', { method: 'POST', body: data });
    usersCache = null;
    showTempPassword(res.user.username, res.temp_password);
  });
  form.username.focus();
}

function showTempPassword(username, password) {
  openDialog(`<h2>臨時密碼</h2>
    <p>請把這組臨時密碼交給 <b>${esc(username)}</b>。對方登入後會被要求立刻改密碼。這組密碼只會顯示這一次。</p>
    <div class="secret">${esc(password)}</div>
    <div class="actions"><button type="button" class="primary" data-close>我記下了</button></div>`);
  dialog.addEventListener('close', () => (me ? render() : go('#/login')), { once: true });
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
  const hash = location.hash || '#/projects';
  if (!me && hash !== '#/login') {
    try {
      me = (await api('/auth/me')).user;
    } catch {
      return;
    }
  }
  if (hash === '#/login') {
    if (me) return go('#/projects');
    return viewLogin();
  }
  if (me.must_change_password && hash !== '#/password') return go('#/password');

  topbar.hidden = false;
  document.getElementById('nav-users').hidden = me.role !== 'admin';
  const section = hash.split('/')[1];
  topbar.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));

  try {
    const m = hash.match(/^#\/projects\/(\d+)$/);
    if (hash === '#/password') viewPassword();
    else if (hash === '#/users') await viewUsers();
    else if (m) await viewProject(Number(m[1]));
    else await viewProjects();
  } catch (e) {
    if (me) app.innerHTML = `<div class="card empty">${esc(e.message)}<br><br><a href="#/projects">回到計劃列表</a></div>`;
  }
}

document.getElementById('logout').addEventListener('click', logout);
window.addEventListener('hashchange', render);
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
