// 用 node:sqlite 模擬 Cloudflare D1 的 API，讓測試不需要 wrangler
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => {
      // 和 D1 一樣整批在同一個交易中執行
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
}
