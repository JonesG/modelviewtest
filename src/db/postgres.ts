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
  createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
});

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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_models_latlon ON models (lat, lon);`);
  }

  async insert(m: NewModel): Promise<ModelRecord> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO models (name, file_path, clip, lat, lon, altitude, heading, scale_m, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [m.name, m.filePath, m.clip ?? null, m.lat, m.lon, m.altitude ?? null, m.heading ?? null, m.scaleM ?? null, m.description ?? null]
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

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM models`);
    return Number(rows[0].n);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
