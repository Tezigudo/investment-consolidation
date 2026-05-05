import { pgPool } from './pg.js';
import { runPgMigrations } from './pg-migrations.js';

export { pgPool as pool } from './pg.js';

// Run migrations on first import — keeps the same auto-init behavior the
// SQLite client used to have. Top-level await means any module that
// imports `pool` blocks until the schema is current.
await runPgMigrations(pgPool);
