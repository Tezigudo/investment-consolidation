import { importBinanceHistory } from '../services/binance-import.js';

// Usage:
//   bun run import:binance                    # everything the API will give us
//   bun run import:binance -- --since 2021-01-01

const argv = process.argv.slice(2);
let sinceMs: number | undefined;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--since') {
    const v = argv[++i];
    const ms = Date.parse(`${v}T00:00:00Z`);
    if (!Number.isFinite(ms)) {
      console.error(`Bad --since: ${v} (expected YYYY-MM-DD)`);
      process.exit(1);
    }
    sinceMs = ms;
  }
}

console.log(
  `[import:binance] starting${sinceMs ? ` from ${new Date(sinceMs).toISOString().slice(0, 10)}` : ' (full history)'}…`,
);

const start = Date.now();
const result = await importBinanceHistory({
  sinceMs,
  onProgress: (phase, detail) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[+${elapsed}s] ${phase}${detail ? ` — ${detail}` : ''}`);
  },
});

console.log('\n=== Import complete ===');
console.log(JSON.stringify(result, null, 2));
