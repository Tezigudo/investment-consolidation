import pg from 'pg';
import { config } from '../config.js';

// pg returns BIGINT (int8) as string by default since values can exceed
// JS Number.MAX_SAFE_INTEGER. Every BIGINT column in our schema stores
// either a ms-epoch (safe through year 287396) or a small surrogate id —
// both fit in JS Number cleanly. Coerce to number on read so call sites
// don't have to remember to parse.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v == null ? null as unknown as number : Number(v)));

export const pgPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pgPool.on('error', (err) => {
  console.error('[pg] idle client error', err);
});
