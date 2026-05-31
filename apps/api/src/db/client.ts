import { pgPool } from './pg.js';
import { runPgMigrations } from './pg-migrations.js';

export { pgPool as pool } from './pg.js';

// Migrations are NOT run at import time anymore. Previously this module did a
// top-level `await runPgMigrations(pgPool)`, which meant importing `pool`
// blocked the WHOLE process until the schema was current. When the DB was
// unreachable — e.g. Neon free-tier compute-quota suspension — that await never
// resolved, so the server never reached app.listen(): /health 502'd and every
// Fly deploy failed its health check (prod was down ~1 week in May 2026 for
// exactly this). Now server.ts calls ensureMigrations() AFTER it starts
// listening, retrying in the background, so the API is always reachable and
// self-heals when the DB returns (no manual redeploy needed).

const MIGRATE_RETRY_MS = 30_000;
let migrationsApplied = false;
let migrating = false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True once the schema has been brought current at least once this process. */
export function migrationsReady(): boolean {
  return migrationsApplied;
}

/**
 * Apply DB migrations, retrying indefinitely until they succeed. Fire-and-forget
 * from boot — NEVER blocks app.listen(). Idempotent (runPgMigrations only
 * applies missing versions), and a no-op once already applied or in-flight.
 */
export async function ensureMigrations(): Promise<void> {
  if (migrationsApplied || migrating) return;
  migrating = true;
  for (let attempt = 1; ; attempt++) {
    try {
      await runPgMigrations(pgPool);
      migrationsApplied = true;
      migrating = false;
      if (attempt > 1) console.log(`[pg] migrations applied after ${attempt} attempts`);
      return;
    } catch (e) {
      console.warn(
        `[pg] migrations attempt ${attempt} failed — DB may be down/quota-blocked; ` +
          `API stays up, retrying in ${MIGRATE_RETRY_MS / 1000}s:`,
        (e as Error).message,
      );
      await sleep(MIGRATE_RETRY_MS);
    }
  }
}
