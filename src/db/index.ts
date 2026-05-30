// Storage factory: picks the adapter from env, initializes it, and seeds a
// couple of sample rows on first run so the nearby list isn't empty.
//
//   DB_DRIVER=sqlite (default)  -> SQLITE_PATH (default ./data/models.db)
//   DB_DRIVER=postgres          -> DATABASE_URL (e.g. postgres://user:pass@host/db)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from './sqlite.ts';
import { PostgresStore } from './postgres.ts';
import type { ModelStore, NewModel } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export async function createStore(): Promise<ModelStore> {
  const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
  let store: ModelStore;

  if (driver === 'postgres' || driver === 'pg') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
    store = new PostgresStore(url);
  } else if (driver === 'sqlite') {
    const file = process.env.SQLITE_PATH ?? path.join(PROJECT_ROOT, 'data', 'models.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    store = new SqliteStore(file);
  } else {
    throw new Error(`Unknown DB_DRIVER "${driver}" (use sqlite or postgres)`);
  }

  await store.init();
  return store;
}

// No demo seeding — models are created at your real location via "Create here".
// (Add entries here if you want default placements on a fresh database.)
const SEED: NewModel[] = [];

export async function seedIfEmpty(store: ModelStore): Promise<number> {
  if ((await store.count()) > 0) return 0;
  for (const m of SEED) await store.insert(m);
  return SEED.length;
}
