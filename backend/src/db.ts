import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data/udu.db');
const MIGRATIONS_DIR = resolve(__dirname, '../../data/migrations');

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (!Number.isFinite(version) || version <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      db.exec('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
