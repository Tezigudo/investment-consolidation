# Consolidate — Investing Dashboard

Personal consolidated investing dashboard. One view across **DIME** (Thai
brokerage, US stocks), **Binance** (crypto), and **bank THB cash**, with
**true-baht PNL** (FX locked at the moment of each deposit/trade).

## Layout

```
investing-consolidate/
├── apps/
│   ├── api/          Fastify + TypeScript + better-sqlite3
│   │   ├── src/
│   │   │   ├── config.ts          zod-validated env loading (reads root .env)
│   │   │   ├── db/                client + migrations (single source of truth)
│   │   │   ├── services/          binance, prices, fx, csv-importer, cost-basis, portfolio
│   │   │   ├── routes/            portfolio, trades, import, symbols, cash
│   │   │   ├── jobs/              node-cron: prices 5m, binance 5m, fx 1h
│   │   │   ├── cli/               import-dime.ts (CSV → SQLite from shell)
│   │   │   └── server.ts          Fastify bootstrap
│   │   ├── fixtures/              sample CSVs
│   │   └── data/                  SQLite file (gitignored)
│   └── web/          Vite + React + TypeScript + TanStack Query
│       └── src/
│           ├── components/        charts, PriceModal, TopBar, DualHeroCell, CsvUpload
│           ├── views/Dashboard.tsx  (Variation B — desktop grid)
│           ├── hooks/usePortfolio.ts
│           ├── api/client.ts
│           ├── lib/               theme vars, currency formatters
│           └── App.tsx, main.tsx, styles.css
├── packages/
│   └── shared/       cross-workspace types (Platform, EnrichedPosition, PortfolioSnapshot, …)
├── design/           original Claude Design HTML/JSX prototype (kept for reference)
├── .env.example
└── package.json      (bun workspaces root)
```

## Setup

Requires [Bun](https://bun.sh) ≥ 1.1 (Node ≥ 20 is still supported as a runtime for
the built API, but tooling is driven by bun).

```bash
bun install
cp .env.example .env          # fill in secrets (see below)
bun run dev                   # starts API on :4000 and web on :5173
```

Open http://localhost:5173.

## The .env file — how to get each secret

Copy `.env.example` → `.env` and fill:

**`BINANCE_API_KEY` / `BINANCE_API_SECRET`** — required for live crypto.

1. Go to https://www.binance.com/en/my/settings/api-management
2. **Create API** (system-generated, HMAC).
3. **API restrictions** — enable **Read-Only only**. Explicitly turn *off*
   "Enable Spot & Margin Trading" and "Enable Withdrawals".
4. **IP access restrictions** — "Restrict access to trusted IPs only" and
   add the IP your server runs from (your laptop's public IP for local
   use, or the VPS IP in prod).
5. Copy the API Key + Secret Key into `.env`. **Secret is shown once.**

**`FINNHUB_API_KEY`** — optional, improves US stock prices.

1. Register free at https://finnhub.io/register (60 req/min on free tier).
2. Copy the token from your dashboard into `.env`.

If blank, the backend falls back to the unofficial Yahoo Finance endpoint.
Either is fine for personal use.

**`DIME_PDF_PASSWORD`** — only needed when you wire up the Gmail PDF
automation (future). Usually your Thai national ID or date of birth. The
CSV importer doesn't need it.

**Gmail OAuth (future automation, not required for MVP)**

1. Go to https://console.cloud.google.com/ → new project.
2. Enable the Gmail API, then **Credentials → Create OAuth client ID →
   Desktop app**.
3. Download the JSON and save it at `./secrets/gmail-credentials.json`.
4. Set `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` in `.env`.

## Loading data

### DIME — CSV import (MVP path)

DIME → Portfolio → Trade history → Export CSV.

Either drop the file on the dashboard (right-side panel) or run:

```bash
cd apps/api
bun run import:dime -- fixtures/dime-sample.csv
```

The importer is lenient about headers — it accepts `Symbol`, `Ticker`,
`Stock`, `Trade Date`, `Exchange Rate`, etc. and maps them to the canonical
schema. See `apps/api/src/services/csv-importer.ts` for the full
`HEADER_MAP`.

**The critical field is the FX rate per trade** (`Exchange Rate`,
`FX`, `THB Rate`, `USDTHB`). Without it the true-baht PNL can't be
computed and you'll see zero FX contribution.

### Binance — automatic once keys are set

The scheduler runs `/api/v3/account` every 5 min and writes the current
balances into `positions`. Prices come from `/api/v3/ticker/price` in
batched calls.

To compute real per-coin PNL (not just today's), also import Binance's
trade history CSV (Wallet → Transaction History → Export). Point the CSV
importer at it with `-- --platform=Binance` or select Binance in the web
upload widget.

### Bank cash

```bash
curl -X PUT http://localhost:4000/cash \
  -H 'Content-Type: application/json' \
  -d '{"platform":"KBANK","label":"Kasikorn Savings","amount_thb":184500}'
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ Binance API │────▶│              │◀────│ Finnhub/Yahoo│
│ (read key)  │     │              │     │   FX API    │
└─────────────┘     │   SQLite     │     └─────────────┘
                    │              │
┌─────────────┐     │  positions,  │     ┌─────────────┐
│ CSV upload  │────▶│  trades,     │────▶│ React web   │
│ (DIME)      │     │  prices,     │     │ (TanStack   │
└─────────────┘     │  fx_rates    │     │  Query 30s) │
                    └──────────────┘     └─────────────┘
                          ▲
                          │
                    node-cron jobs
```

**Hot path (`GET /portfolio`)** reads exclusively from SQLite — no
outbound calls. Cron refreshes the tables every 5–60 min so the frontend
can poll cheaply. `?refresh=1` forces a live pull on demand.

## Commands

```bash
bun run dev             # api + web concurrently
bun run build           # typecheck + build both
bun run typecheck       # just typecheck
bun run --filter @consolidate/api test    # unit tests (vitest)
bun run import:dime -- <csv> [platform]
```

## True-baht PNL math

Every buy stores `fx_at_trade`. For each position:

```
cost_basis_USD = Σ qty_i * price_i
cost_basis_THB = Σ qty_i * price_i * fx_at_trade_i   -- FX locked per fill
market_USD     = qty_now * price_now
market_THB     = market_USD * fx_now
pnl_USD        = market_USD - cost_basis_USD         -- asset appreciation
pnl_THB        = market_THB - cost_basis_THB         -- what you actually gain in baht
fx_contrib_THB = cost_basis_USD * (fx_now - fx_locked_avg)
market_pnl_THB = pnl_THB - fx_contrib_THB
```

The dashboard's "True PNL breakdown" splits **Market PNL** from **FX
contribution** so you see which half of the gain is real vs a currency
move.

Unit tests for the weighted-average + partial-sell + DIV semantics live
at `apps/api/src/services/cost-basis.test.ts`.

## What's not built yet

- Gmail → PDF pipeline (design/chats/chat1.md has the full investigation).
- Websocket live prices (HTTP polling at 5 min is fine for personal use).
- Historical portfolio snapshots table — the hero chart is currently
  synthesized between today's cost and today's market. Easy to add: a
  `snapshots` table + a daily cron.
