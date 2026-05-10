import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root .env lives at repo top-level; load from there.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  // Shared-secret bearer token. Required in production; optional in
  // dev so localhost runs don't need to set it. When set, every API
  // call must send `Authorization: Bearer <token>`. Mobile reads it
  // from secure-ish storage; web from localStorage (Settings paste).
  API_AUTH_TOKEN: z.string().default(''),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),

  FINNHUB_API_KEY: z.string().optional(),

  DIME_PDF_PASSWORD: z.string().optional(),
  GMAIL_CREDENTIALS_PATH: z.string().optional(),
  GMAIL_TOKEN_PATH: z.string().optional(),
  // In-band alternatives to *_PATH for environments where you can't ship
  // a file (Fly, Cloudflare Workers, etc.). Hold the raw JSON contents
  // of the OAuth client + saved refresh-token, respectively. Either raw
  // JSON (`{...}`) or base64-encoded JSON is accepted — the loader
  // sniffs the first non-whitespace char.
  GMAIL_CREDENTIALS_JSON: z.string().optional(),
  GMAIL_TOKEN_JSON: z.string().optional(),

  // Postgres connection string. Defaults to the docker-compose service
  // (consolidate/consolidate@127.0.0.1:5432/consolidate). Override per env.
  DATABASE_URL: z
    .string()
    .default('postgres://consolidate:consolidate@127.0.0.1:5432/consolidate'),

  // ─── On-chain (World Chain) ────────────────────────────────────────
  // Wallet to track (the EOA that holds WLD on World Chain — UNO wallet).
  ONCHAIN_WLD_WALLET: z.string().default(''),
  // Worldcoin (WLD) ERC-20 contract on World Chain (canonical).
  ONCHAIN_WLD_TOKEN: z
    .string()
    .default('0x2cFc85d8E48F8EAB294be644d9E25C3030863003'),
  // Comma-separated list of ERC-4626 vault addresses denominated in WLD
  // (e.g. Re7WLD on Morpho). Each will be queried with `convertToAssets`
  // to convert vault shares back to underlying WLD.
  ONCHAIN_WLD_VAULTS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  // Public RPC endpoint for World Chain. Default works without an API
  // key but is rate-limited; swap for Alchemy/QuickNode if you hit caps.
  ONCHAIN_WLD_RPC: z
    .string()
    .default('https://worldchain-mainnet.g.alchemy.com/public'),
  // Cost basis for the WLD position (USD). Default $0 — assumes the WLD
  // came as a free claim from World App. Set to your acquisition cost
  // if you bought any.
  ONCHAIN_WLD_COST_USD: z.coerce.number().nonnegative().default(0),
  // Comma-separated list of ERC-20 contract addresses that send WLD to
  // the wallet as airdrops/grants (e.g. the Worldcoin weekly grant
  // distributor). The dashboard sums incoming WLD from these specific
  // addresses as a separate "Airdrop received" stat — distinct from
  // vault yield, which represents share-price appreciation.
  // Default address is the Worldcoin grant distributor on World Chain.
  ONCHAIN_WLD_AIRDROP_SOURCES: z
    .string()
    .default('0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  // When set, the boot-time portfolio-snapshot backfill will also walk
  // Yahoo + Binance to backfill prices_daily / fx_daily over the entire
  // history window before computing snapshots. Off by default — the
  // deep warm is heavy (multiple seconds of upstream calls + memory)
  // and only needs to run once per fresh deploy. Trigger it on demand
  // via `GET /portfolio/history?backfill=deep` after a deploy.
  SNAPSHOT_DEEP_WARM: z
    .string()
    .default('')
    .transform((s) => s === '1' || s.toLowerCase() === 'true'),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  dataDir: string;
  dbPath: string;
  databaseUrl: string;
  binanceEnabled: boolean;
  onchainEnabled: boolean;
  authEnabled: boolean;
};

function build(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const env = parsed.data;
  // Refuse to boot in production without an auth token — silent open
  // APIs are a footgun. Dev (NODE_ENV=development) skips this check.
  if (env.NODE_ENV === 'production' && !env.API_AUTH_TOKEN) {
    console.error(
      '[config] API_AUTH_TOKEN is required in production. Set a long random string (e.g. `openssl rand -hex 32`).',
    );
    process.exit(1);
  }
  const dataDir = path.resolve(__dirname, '../data');
  return {
    ...env,
    dataDir,
    dbPath: path.join(dataDir, 'consolidate.sqlite'),
    databaseUrl: env.DATABASE_URL,
    binanceEnabled: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET),
    onchainEnabled: Boolean(env.ONCHAIN_WLD_WALLET),
    authEnabled: Boolean(env.API_AUTH_TOKEN),
  };
}

export const config = build();
