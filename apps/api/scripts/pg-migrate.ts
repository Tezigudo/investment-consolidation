// One-shot CLI: applies any pending Postgres migrations against
// $DATABASE_URL (defaults to the docker-compose service).
//   bun run --filter @consolidate/api migrate:pg
import { pgPool } from '../src/db/pg.js';
import { runPgMigrations } from '../src/db/pg-migrations.js';

async function main() {
  await runPgMigrations(pgPool);
  await pgPool.end();
  console.log('[pg-migrate] done');
}

main().catch((e) => {
  console.error('[pg-migrate] failed:', e);
  process.exit(1);
});
