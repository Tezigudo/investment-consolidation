# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Personal consolidated investing dashboard for a Thai investor holding US
stocks via DIME (Thai broker), crypto via Binance, and THB bank cash.
The core value prop is **"true-baht PNL"** — PNL computed against the
USDTHB rate *locked at the time of each deposit/trade*, not today's
rate — plus a decomposition of PNL into asset appreciation vs FX
contribution. That decomposition is the thing most simple dashboards get
wrong; don't break it.

## Layout (bun workspaces)

- `apps/api/` — Fastify + TypeScript + better-sqlite3. Migrations, Binance HMAC client, CSV importer, portfolio aggregator, cron jobs, CLI.
- `apps/web/` — Vite + React 18 + TypeScript + TanStack Query. One desktop-grid dashboard.
- `packages/shared/` — cross-workspace types (`PortfolioSnapshot`, `EnrichedPosition`, `TradeRow`, `Currency`, …). **Contract between api and web — keep both sides importing from here, never duplicate the shapes.**
- `design/` — original Claude Design HTML/JSX prototype, kept for visual reference only. Do not import from it.

## Commands

```bash
bun install
bun run dev             # concurrent api (:4000) + web (:5173)
bun run dev:api         # api only
bun run dev:web         # web only
bun run typecheck       # both workspaces in parallel
bun run build           # typecheck + vite build
bun run --filter @consolidate/api test            # vitest
bun run --filter @consolidate/api test -- cost-basis  # single test file
bun run import:dime -- apps/api/fixtures/dime-sample.csv
```

Bun is the package manager and workspace task runner. The **API itself still runs under Node** (`tsx watch` for dev, `node dist/server.js` for start) because `better-sqlite3`'s prebuilt N-API binary segfaults under Bun's runtime as of 1.2.x. Don't "simplify" the api's `dev`/`start` to `bun --watch` / `bun dist/...` without first swapping to `bun:sqlite` (which would mean a rewrite of `db/client.ts` and `db/migrations.ts`). The web side runs fine under Bun.

The web dev server proxies `/api/*` → `http://127.0.0.1:4000` (see `apps/web/vite.config.ts`). The frontend always calls `/api/...` — never hard-code `localhost:4000` into components.

## Hot-path discipline (important)

`GET /portfolio` must read **only from SQLite** (`positions`, `prices`, `fx_rates`, `cash`, `trades` tables). The frontend polls this endpoint every 30s via TanStack Query — making it hit Binance/Finnhub/Yahoo on every request will rate-limit you fast.

Live outbound calls live in:

- `src/jobs/scheduler.ts` — cron: prices every 5min, Binance holdings every 5min, FX every hour, plus a one-shot warm-up on server boot.
- `buildSnapshot({ refresh: true })` — triggered only by `GET /portfolio?refresh=1` (manual "refresh now" escape hatch).

When adding a new data source, put the fetch in a cron job that writes to SQLite, and add a read-from-DB code path in `src/services/portfolio.ts`. Don't add fetches to request handlers.

## True-baht PNL math (don't break this)

Every trade row carries `fx_at_trade` (USDTHB at the moment of the fill). The pure function at `apps/api/src/services/cost-basis.ts` is the single source of truth for cost-basis math:

- BUY: accumulates `qty`, `costUSD`, `costTHB = qty × price × fx_at_trade`
- SELL: reduces qty and scales both cost bases by `1 - sellFrac` (weighted-avg preserved)
- DIV: ignored for cost basis

`src/services/portfolio.ts:enrich()` then splits the PNL into:
- `pnlUSD = marketUSD - costUSD` (asset appreciation)
- `pnlTHB = marketTHB - costTHB` (what the user actually gains in baht)
- `fxContribTHB = costUSD × (marketFX - fxLocked)` (pure currency effect)

The dashboard shows `pnlTHB - fxContribTHB` as "Market PNL" and `fxContribTHB` as "FX contribution." If you change cost-basis math, update `cost-basis.test.ts` (5 cases covering buy-only, partial sell, full sell + rebuy, DIV, and SELL-before-BUY).

## CSV importer

`src/services/csv-importer.ts` is intentionally lenient on headers — it accepts `Symbol`/`Ticker`/`Stock`, `Exchange Rate`/`FX`/`USDTHB`, etc. (see `HEADER_MAP`). New header variants: add them there.

The **critical column is FX per trade**. Rows without it get rejected by zod. If a user complains about missing PNL, check that their CSV has the FX column populated.

Dedup uses `UNIQUE(platform, external_id)`. When the CSV has no order ID, the importer synthesizes `${platform}:${symbol}:${ts}:${qty}:${price}` — re-imports of the same file are idempotent.

## Binance integration

`src/services/binance.ts` signs queries with HMAC-SHA256 (`timestamp` + `recvWindow`). Required env: `BINANCE_API_KEY` + `BINANCE_API_SECRET`. The key **must** be read-only with Spot trading and withdrawals disabled, IP-whitelisted. If keys are missing, `config.binanceEnabled` is false and Binance calls short-circuit with a clear error — this is the expected dev state without credentials.

Pricing is served by `/api/v3/ticker/price` in a single batched call (array form with quoted symbols). Don't switch to per-symbol calls.

## Env loading

`apps/api/src/config.ts` loads `.env` from the **repo root** (not `apps/api/.env`). Vite does the same via `envDir: root` in its config. Only add env vars to one place — the root `.env`.

## Database

`apps/api/data/consolidate.sqlite` (gitignored). Migrations run on `import { db } from './db/client.js'`. Add new migrations as appended entries in `MIGRATIONS` in `src/db/migrations.ts` with a monotonically increasing `version`; never edit applied migrations in place.

Tables carry intent: `deposits.fx_locked`, `trades.fx_at_trade`, and `positions.cost_basis_thb` are the FX-locked columns. If you add a new source of trades, make sure it writes an FX rate per row or the whole PNL model fails silently.

## Design prototype

`design/` contains the original HTML/JSX prototype from Claude Design. It uses in-browser Babel + React from CDN and a `DesignCanvas` pan/zoom wrapper — do not port that wrapper. Treat the prototype as a visual spec; the production components in `apps/web/src/components/` are the real source.
