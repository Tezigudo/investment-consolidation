import { importBinanceHistory, getLastBinanceSyncTs } from '../services/binance-import.js';

// Usage:
//   bun run import:binance                    # incremental (from last cursor) or full if first run
//   bun run import:binance -- --since 2021-01-01
//   bun run import:binance -- --full           # force full history from 2017

const argv = process.argv.slice(2);
let sinceMs: number | undefined;
let forceLabel = '';

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--since') {
    const v = argv[++i];
    const ms = Date.parse(`${v}T00:00:00Z`);
    if (!Number.isFinite(ms)) {
      console.error(`Bad --since: ${v} (expected YYYY-MM-DD)`);
      process.exit(1);
    }
    sinceMs = ms;
    forceLabel = ` from ${new Date(ms).toISOString().slice(0, 10)}`;
  } else if (argv[i] === '--full') {
    sinceMs = undefined;
    forceLabel = ' (full history)';
  }
}

if (!forceLabel) {
  // Default: incremental — cursors in binance_sync_state handle the
  // start point automatically. Show the last sync time for context.
  const lastTs = getLastBinanceSyncTs();
  if (lastTs) {
    const ago = Math.round((Date.now() - lastTs) / 1000);
    const when = new Date(lastTs).toISOString().replace('T', ' ').slice(0, 19);
    forceLabel = ` (incremental, last sync: ${when} UTC, ${ago}s ago)`;
  } else {
    forceLabel = ' (first run — full history)';
  }
}

console.log(
  `[import:binance] starting${forceLabel}…`,
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
const { counts, durationMs, symbolsProbed } = result;
console.log(
  `  Trades:      ${counts.trades}\n` +
  `  Deposits:    ${counts.deposits}\n` +
  `  Rewards:     ${counts.rewards}\n` +
  `  Withdrawals: ${counts.withdrawals}\n` +
  `  Errors:      ${counts.errors}\n` +
  `  Symbols:     ${symbolsProbed} probed\n` +
  `  Duration:    ${(durationMs / 1000).toFixed(1)}s`,
);
