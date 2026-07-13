import { appDataDir, dbPath } from './env/app-data.js';
import { dbInfo, type DbInfo } from './storage/db.js';
import { ProviderRouter } from './providers/router.js';
import type { HealthResult } from './providers/types.js';

export interface DoctorReport {
  node: string;
  platform: string;
  appDataDir: string;
  dbPath: string;
  db: DbInfo;
  providers: HealthResult[];
  ready: boolean;
}

/** Environment + storage + provider health snapshot (powers `healix doctor` and the desktop UI). */
export async function doctor(opts: { probe?: boolean } = {}): Promise<DoctorReport> {
  const router = new ProviderRouter();
  const [db, providers] = await Promise.all([dbInfo(), router.healthAll({ probe: opts.probe ?? true })]);
  const ready = providers.some((p) => p.status === 'ready' && p.authenticated);
  return {
    node: process.version,
    platform: process.platform,
    appDataDir: appDataDir(),
    dbPath: dbPath(),
    db,
    providers,
    ready,
  };
}
