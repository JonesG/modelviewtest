// Postgres storage adapter (pg). Selected when DB_DRIVER=postgres.

import pg from 'pg';
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
  created_at: Date | string;
};

const toRecord = (r: Row): ModelRecord => ({
  id: Number(r.id),
  name: r.name,
  filePath: r.file_path,
  clip: r.clip,
  lat: Number(r.lat),
  lon: Number(r.lon),
  altitude: r.altitude === null ? null : Number(r.altitude),
  heading: r.heading === null ? null : Number(r.heading),
  scaleM: r.scale_m === null ? null : Number(r.scale_m),
  description: r.description,
  markerSrc: r.marker_src ?? null,
  targetIndex: r.target_index === null || r.target_index === undefined ? null : Number(r.target_index),
  createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
});

// camelCase field -> DB column, for partial updates.
const COLUMN: Record<string, string> = {
  name: 'name', filePath: 'file_path', clip: 'clip', lat: 'lat', lon: 'lon',
  altitude: 'altitude', heading: 'heading', scaleM: 'scale_m', description: 'description',
  markerSrc: 'marker_src', targetIndex: 'target_index',
};

export class PostgresStore implements ModelStore {
  readonly driver = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS models (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        clip TEXT,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        altitude DOUBLE PRECISION,
        heading DOUBLE PRECISION,
        scale_m DOUBLE PRECISION,
        description TEXT,
        marker_src TEXT,
        target_index INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_models_latlon ON models (lat, lon);`);
    // Migrate older databases that predate the marker columns.
    await this.pool.query(`ALTER TABLE models ADD COLUMN IF NOT EXISTS marker_src TEXT`);
    await this.pool.query(`ALTER TABLE models ADD COLUMN IF NOT EXISTS target_index INTEGER`);
  }

  async insert(m: NewModel): Promise<ModelRecord> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO models (name, file_path, clip, lat, lon, altitude, heading, scale_m, description, marker_src, target_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [m.name, m.filePath, m.clip ?? null, m.lat, m.lon, m.altitude ?? null, m.heading ?? null, m.scaleM ?? null, m.description ?? null, m.markerSrc ?? null, m.targetIndex ?? null]
    );
    return toRecord(rows[0]);
  }

  async all(): Promise<ModelRecord[]> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM models ORDER BY id`);
    return rows.map(toRecord);
  }

  async getById(id: number): Promise<ModelRecord | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM models WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listNearby(lat: number, lon: number, radiusM: number): Promise<NearbyModel[]> {
    const bb = boundingBox(lat, lon, radiusM);
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM models WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
      [bb.minLat, bb.maxLat, bb.minLon, bb.maxLon]
    );
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
    const res = await this.pool.query(`DELETE FROM models WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async update(id: number, fields: Partial<NewModel>): Promise<ModelRecord | null> {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!COLUMN[k]) continue;
      vals.push(v as string | number | null);
      sets.push(`${COLUMN[k]} = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(id);
      await this.pool.query(`UPDATE models SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    return this.getById(id);
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM models`);
    return Number(rows[0].n);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
