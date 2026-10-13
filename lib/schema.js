// 資料庫結構版本管理：程式啟動後第一次收到請求時自動升級，不必手動到 Console 執行 SQL
// 新增結構時，在 MIGRATIONS 最後加一個版本即可，已執行過的版本不要再修改

const MIGRATIONS = [
  {
    version: 1,
    // 第一版：用 IF NOT EXISTS，讓先前手動建立過資料表的資料庫也能直接沿用
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        must_change_password INTEGER NOT NULL DEFAULT 1,
        disabled INTEGER NOT NULL DEFAULT 0,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        start_date TEXT,
        end_date TEXT,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
        due_date TEXT,
        assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        position REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position)`,
    ],
  },
  {
    version: 2,
    // 預算、支出、里程碑，以及任務的進度與權重
    statements: [
      `ALTER TABLE projects ADD COLUMN budget INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks ADD COLUMN weight REAL NOT NULL DEFAULT 1`,
      `CREATE TABLE budget_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        planned_amount INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_budget_items_project ON budget_items(project_id)`,
      `CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        budget_item_id INTEGER REFERENCES budget_items(id) ON DELETE SET NULL,
        task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        spent_on TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_expenses_project ON expenses(project_id, spent_on)`,
      `CREATE TABLE milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        due_date TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        done_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_milestones_project ON milestones(project_id, due_date)`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

async function currentVersion(db) {
  const row = await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').first();
  return row?.v ?? 0;
}

async function migrate(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
    .run();
  for (const m of MIGRATIONS) {
    if ((await currentVersion(db)) >= m.version) continue;
    try {
      // batch 在 D1 上是同一個交易，失敗會整批還原
      await db.batch([
        ...m.statements.map((sql) => db.prepare(sql)),
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').bind(m.version, Date.now()),
      ]);
    } catch (err) {
      // 同時有另一個請求已經完成升級時，這裡會因為重複建立而失敗，確認版本即可
      if ((await currentVersion(db)) < m.version) throw err;
    }
  }
}

// 每個執行個體只檢查一次
const ready = new WeakMap();

export function ensureSchema(db) {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch((err) => {
      ready.delete(db);
      throw err;
    });
    ready.set(db, p);
  }
  return p;
}
