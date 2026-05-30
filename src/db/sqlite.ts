// SQLite storage adapter using Node's built-in node:sqlite (no native deps).

import { DatabaseSync } from 'node:sqlite';
import { boundingBox, distanceMeters, bearingDegrees } from './geo.ts';
import type { ModelRecord, ModelStore, NearbyModel, NewModel } from './types.ts';

type Row = {
  id: number;
  name: string;
  file_path: string;
  clip: string | null;
  lat: number;
  lon: number;
  altitude: number | null;
  heading: number | null;
  scale_m: number | null;
  description: string | null;
  marker_src: string | null;
  target_index: number | null;
  created_at: string;
};

const toRecord = (r: Row): ModelRecord => ({
  id: r.id,
  name: r.name,
  filePath: r.file_path,
  clip: r.clip,
  lat: r.lat,
  lon: r.lon,
  altitude: r.altitude,
  heading: r.heading,
  scaleM: r.scale_m,
  description: r.description,
  markerSrc: r.marker_src ?? null,
  targetIndex: r.target_index ?? null,
  createdAt: r.created_at,
});

// camelCase field -> DB column, for updates/inserts of optional fields.
const COLUMN: Record<string, string> = {
  name: 'name', filePath: 'file_path', clip: 'clip', lat: 'lat', lon: 'lon',
  altitude: 'altitude', heading: 'heading', scaleM: 'scale_m', description: 'description',
  markerSrc: 'marker_src', targetIndex: 'target_index',
};

export class SqliteStore implements ModelStore {
  readonly driver = 'sqlite' as const;
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        clip TEXT,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        altitude REAL,
        heading REAL,
        scale_m REAL,
        description TEXT,
        marker_src TEXT,
        target_index INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_models_latlon ON models (lat, lon);
    `);
    // Migrate older databases that predate the marker columns.
    const cols = (this.db.prepare(`PRAGMA table_info(models)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('marker_src')) this.db.exec(`ALTER TABLE models ADD COLUMN marker_src TEXT`);
    if (!cols.includes('target_index')) this.db.exec(`ALTER TABLE models ADD COLUMN target_index INTEGER`);
  }

  async insert(m: NewModel): Promise<ModelRecord> {
    const info = this.db
      .prepare(
        `INSERT INTO models (name, file_path, clip, lat, lon, altitude, heading, scale_m, description, marker_src, target_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.name,
        m.filePath,
        m.clip ?? null,
        m.lat,
        m.lon,
        m.altitude ?? null,
        m.heading ?? null,
        m.scaleM ?? null,
        m.description ?? null,
        m.markerSrc ?? null,
        m.targetIndex ?? null
      );
    const row = this.db.prepare(`SELECT * FROM models WHERE id = ?`).get(Number(info.lastInsertRowid)) as Row;
    return toRecord(row);
  }

  async all(): Promise<ModelRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM models ORDER BY id`).all() as Row[];
    return rows.map(toRecord);
  }

  async getById(id: number): Promise<ModelRecord | null> {
    const row = this.db.prepare(`SELECT * FROM models WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async listNearby(lat: number, lon: number, radiusM: number): Promise<NearbyModel[]> {
    const bb = boundingBox(lat, lon, radiusM);
    const rows = this.db
      .prepare(`SELECT * FROM models WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`)
      .all(bb.minLat, bb.maxLat, bb.minLon, bb.maxLon) as Row[];
    return rows
      .map(toRecord)
      .map((m) => ({
        ...m,
        distanceM: distanceMeters(lat, lon, m.lat, m.lon),
        bearingDeg: bearingDegrees(lat, lon, m.lat, m.lon),
      }))
      .filter((m) => m.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  async delete(id: number): Promise<boolean> {
    const info = this.db.prepare(`DELETE FROM models WHERE id = ?`).run(id);
    return Number(info.changes) > 0;
  }

  async update(id: number, fields: Partial<NewModel>): Promise<ModelRecord | null> {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!COLUMN[k]) continue;
      sets.push(`${COLUMN[k]} = ?`);
      vals.push(v as string | number | null);
    }
    if (sets.length) {
      vals.push(id);
      this.db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.getById(id);
  }

  async count(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM models`).get() as { n: number };
    return row.n;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
