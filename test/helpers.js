/** Test doubles: D1 over node:sqlite and an in-memory R2 bucket. */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  return db;
}

/** Minimal D1 API over node:sqlite. */
export function d1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first(col) {
      const row = db.prepare(sql).get(...params);
      return row ? (col ? row[col] : { ...row }) : null;
    },
    async all() { return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

/** Enough of the R2 binding for put/get/delete. */
export function r2() {
  const store = new Map();
  return {
    store,
    async put(key, bytes) { store.set(key, bytes); },
    async get(key) { return store.has(key) ? { body: store.get(key) } : null; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  };
}

export const form = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) });
