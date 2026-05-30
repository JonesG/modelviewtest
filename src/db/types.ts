// Storage model + the adapter interface implemented by SQLite and Postgres.

export type NewModel = {
  name: string;
  /** Path served by the static server, e.g. "models/RobotExpressive.glb". */
  filePath: string;
  /** Animation clip to play / bake for iOS (optional). */
  clip?: string | null;
  lat: number;
  lon: number;
  altitude?: number | null;
  /** Facing direction in degrees (0 = north), optional. */
  heading?: number | null;
  /** Target real-world size in meters for AR (largest dimension). */
  scaleM?: number | null;
  description?: string | null;
};

export type ModelRecord = NewModel & {
  id: number;
  createdAt: string;
};

/** A model returned by a proximity query, annotated with distance + bearing. */
export type NearbyModel = ModelRecord & {
  distanceM: number;
  bearingDeg: number;
};

export interface ModelStore {
  readonly driver: 'sqlite' | 'postgres';
  init(): Promise<void>;
  insert(model: NewModel): Promise<ModelRecord>;
  all(): Promise<ModelRecord[]>;
  getById(id: number): Promise<ModelRecord | null>;
  /** Models within radiusM of (lat, lon), sorted nearest-first. */
  listNearby(lat: number, lon: number, radiusM: number): Promise<NearbyModel[]>;
  /** Delete a model by id; resolves true if a row was removed. */
  delete(id: number): Promise<boolean>;
  count(): Promise<number>;
  close(): Promise<void>;
}
