import fs from 'node:fs';
import path from 'node:path';
import { importTradesCsv } from '../services/csv-importer.js';

const argv = process.argv.slice(2);
const file = argv[0];
const platform = (argv[1] ?? 'DIME') as 'DIME' | 'Binance';

if (!file) {
  console.error('Usage: npm run import:dime -- <path-to-csv> [platform]');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error(`File not found: ${abs}`);
  process.exit(1);
}

const text = fs.readFileSync(abs, 'utf8');
const summary = await importTradesCsv(text, platform);
console.log(JSON.stringify(summary, null, 2));
