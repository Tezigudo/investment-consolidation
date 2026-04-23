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

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),

  FINNHUB_API_KEY: z.string().optional(),

  DIME_PDF_PASSWORD: z.string().optional(),
  GMAIL_CREDENTIALS_PATH: z.string().optional(),
  GMAIL_TOKEN_PATH: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  dataDir: string;
  dbPath: string;
  binanceEnabled: boolean;
};

function build(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const env = parsed.data;
  const dataDir = path.resolve(__dirname, '../data');
  return {
    ...env,
    dataDir,
    dbPath: path.join(dataDir, 'consolidate.sqlite'),
    binanceEnabled: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET),
  };
}

export const config = build();
