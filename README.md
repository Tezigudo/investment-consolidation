# Consolidate — Investing Dashboard

Personal consolidated investing dashboard for a Thai investor. One view across:

- **DIME** — Thai broker for US stocks (GOOGL, NVDA, …)
- **Binance** — crypto, including Earn rewards
- **On-chain** (World Chain) — wallet balance, ERC-4626 vault yield, Worldcoin airdrops
- **Bank THB cash**

The core value prop is **"true-baht PNL"** — PNL computed against the USDTHB rate *locked at the time of each deposit/trade*, not today's rate — plus a decomposition of PNL into asset appreciation vs FX contribution. That's the thing most simple dashboards get wrong.

Installable as a **PWA** so the same React bundle runs on desktop and on the user's phone after "Add to Home Screen" — no separate native app.

## Layout

```
investing-consolidate/
├── apps/
│   ├── api/          Fastify + TypeScript + Postgres (pg)
│   │   ├── src/
│   │   │   ├── config.ts               zod-validated env loading (reads root .env)
│   │   │   ├── db/                     pg client + append-only migrations
│   │   │   ├── services/
│   │   │   │   ├── cost-basis.ts       weighted-avg + FIFO cost-basis (single source of truth)
│   │   │   │   ├── portfolio.ts        snapshot aggregator, refreshBinance
│   │   │   │   ├── portfolio-history.ts daily snapshot table + backfill
│   │   │   │   ├── binance.ts          HMAC client, balances, prices
│   │   │   │   ├── binance-import.ts   5-year history sync (myTrades, deposits, converts, fiat, earn)
│   │   │   │   ├── binance-history.ts  paged endpoint walkers
│   │   │   │   ├── csv-importer.ts     DIME CSV → trades
│   │   │   │   ├── dime-mail.ts        Gmail → DIME PDF parser → deposits + trades
│   │   │   │   ├── onchain.ts          viem reads on World Chain (balance, vaults, airdrops)
│   │   │   │   ├── prices.ts           live USD prices (Yahoo + Binance batched)
│   │   │   │   ├── price-history.ts    daily kline cache (prices_daily)
│   │   │   │   ├── fx.ts + fx-history.ts  USDTHB live + daily series
│   │   │   ├── routes/
│   │   │   │   ├── portfolio.ts        /portfolio, /portfolio/history (TWR), /portfolio/attribution
│   │   │   │   ├── symbols.ts          /symbols/:sym/history (per-position chart)
│   │   │   │   ├── deposits.ts         /deposits ledger
│   │   │   │   ├── income.ts           /income (Earn + vault yield + airdrops + dividends)
│   │   │   │   └── trades, import, cash, dime-mail
│   │   │   ├── jobs/scheduler.ts       cron: prices 5m, Binance 5m, FX 1h, on-chain 5m, snapshots 6h
│   │   │   ├── cli/                    import-dime, import-binance, dime-mail
│   │   │   └── server.ts               Fastify bootstrap
│   │   └── fixtures/, data/
│   └── web/          Vite + React 18 + TanStack Query, PWA
│       └── src/
│           ├── components/             charts, PriceModal, TopBar, FxScenario, IncomeCenter, etc.
│           ├── views/
│           │   ├── Dashboard.tsx       desktop dashboard (analyst pack: TWR, attribution, DD, …)
│           │   ├── MobileShell.tsx     mobile router (Overview / Holdings / Activity / Settings)
│           │   └── mobile/             tab views + PositionSheet drilldown
│           ├── hooks/usePortfolio.ts
│           ├── lib/useIsMobile.ts      viewport breakpoint switch
│           ├── api/client.ts           tokenized fetch wrapper
│           └── App.tsx, main.tsx, styles.css
├── packages/
│   └── shared/       cross-workspace types (Platform, EnrichedPosition, PortfolioSnapshot, Totals, …)
├── design/           original Claude Design HTML/JSX prototype (reference only)
├── docker-compose.yml  local Postgres (db user/password "consolidate")
├── fly.toml          investment-consolidation app, sin region, 512MB shared-cpu
├── .env.example
└── package.json      bun workspaces root
```

## Setup

Requires [Bun](https://bun.sh) ≥ 1.1 and Docker (for local Postgres). The deployed API runs Node 24 on Fly.

```bash
docker compose up -d db        # local Postgres on :5432
bun install
cp .env.example .env           # fill in secrets (see below)
bun run dev                    # API on :4000, web on :5173 (proxies /api → :4000)
```

Open http://localhost:5173. The dev API binds to `0.0.0.0:4000` so a phone on the same LAN can reach it for PWA testing.

## What lives where in the dashboard

**Desktop** (`Dashboard.tsx`):
- Hero net-worth card with **historical area chart** (1M/3M/6M/1Y/ALL — real daily snapshots, not synthesized)
- **True PNL · breakdown** card with the FX-locked decomposition + ⓘ tooltip
- **TWR** YTD / 1Y / All under the True PNL card
- **What if USDTHB →** scenario slider — preview any FX level
- **Today / Week / Month / YTD** delta strip
- **By asset class** donut (sectors), **By platform** bars (with idle-USDT cash hint), **Top movers**
- **Concentration** (HHI + Top 1 / Top 3) and **Drawdown** (current + max with peak→trough dates)
- **Deposits ledger** + **Income · TTM** (Earn / Vault / Airdrop / Dividends ≈ N% on capital)
- **Trading attribution** — "what if I'd never sold?" counterfactual (USD only)
- **Holdings table** with per-position drilldown to a price-history modal

**Mobile** (`MobileShell.tsx`): the same React bundle, tabs (Overview / Holdings / Activity / Settings) and a `PositionSheet` drilldown. Overview mirrors the desktop analyst pack in mobile-compact form.

## The .env file — how to get each secret

**`DATABASE_URL`** (required) — Postgres connection string.

For local: `postgresql://consolidate:consolidate@localhost:5432/consolidate` (matches `docker-compose.yml`).
For prod: a Neon (or any managed Postgres) URL.

**`API_AUTH_TOKEN`** (required for prod, optional for localhost) — 32+ char hex token.

```bash
openssl rand -hex 32
```

The API rejects every request except `/health` without a matching `Authorization: Bearer <token>` header. The web app stores the same token in `localStorage` via the bottom-right Tweaks panel.

**`BINANCE_API_KEY` / `BINANCE_API_SECRET`** — read-only, IP-whitelisted.

1. https://www.binance.com/en/my/settings/api-management → **Create API** (system-generated, HMAC).
2. **API restrictions** — enable **Read-Only only**. Explicitly turn *off* "Enable Spot & Margin Trading" and "Enable Withdrawals".
3. **IP access restrictions** — restrict to your server's IP (laptop public IP locally, Fly outbound IP in prod).
4. Copy the Key + Secret into `.env`. The Secret is shown once.

If unset, `config.binanceEnabled` is false and Binance calls short-circuit cleanly — fine for getting a feel for the dashboard before wiring up an account.

**`ONCHAIN_WLD_WALLET`** — your World Chain wallet address (`0x…`).

**`ONCHAIN_WLD_VAULTS`** — comma-separated ERC-4626 vault addresses you've deposited into.

**`ONCHAIN_WLD_AIRDROP_SOURCES`** — comma-separated distributor contract addresses (defaults to the Worldcoin weekly grant `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`).

**`ALCHEMY_API_KEY`** (optional) — public RPC works fine; an Alchemy key just raises rate limits.

**`FINNHUB_API_KEY`** (optional) — improves US stock prices.

Free at https://finnhub.io/register (60 req/min). If blank, the backend falls back to Yahoo's unofficial chart endpoint — fine for personal use.

**Gmail OAuth (DIME mail importer)** — only needed if you want DIME deposits + trades to import automatically from email confirmations.

1. https://console.cloud.google.com/ → new project → enable Gmail API.
2. **Credentials → Create OAuth client ID → Desktop app** → download the JSON to `./secrets/gmail-credentials.json`.
3. Set `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` in `.env`.
4. `DIME_PDF_PASSWORD` — your DIME PDF password (typically Thai national ID or DOB).

## Loading data

### DIME

**CSV (one-shot)** — DIME → Portfolio → Trade history → Export CSV. Drop the file on the dashboard, or:

```bash
bun run import:dime -- path/to/your-export.csv
```

The importer is lenient about headers (`Symbol`, `Ticker`, `Stock`, `Exchange Rate`, `FX`, `USDTHB`, …) — see `HEADER_MAP` in `apps/api/src/services/csv-importer.ts`. The **critical column is the FX rate per trade**; without it the FX-locked cost basis can't be computed.

**Mail (continuous)** — once the Gmail OAuth + PDF password are configured, the DIME mail cron parses KKP→DIME deposit confirmations and trade execution PDFs into the database. Trigger a manual run:

```bash
bun run --filter @consolidate/api cli -- dime-mail
```

### Binance

Live balances + prices refresh every 5 min via the scheduler. For full history (5-year backfill of trades, deposits, converts, Earn rewards, fiat orders), run once:

```bash
bun run --filter @consolidate/api cli -- import-binance
```

Subsequent invocations are incremental (cursors in `binance_sync_state`). After the initial backfill, an hourly cron keeps things fresh.

**USDT and other stablecoins on Binance are treated as cash, not crypto positions.** Their balance shows as a "Binance USDT cash" row; PNL comes from real BUY/SELL/CONVERT history of non-stable assets.

### On-chain (World Chain)

Configured wallets/vaults are read every 5 min via viem's public client (no key required). Three things are tracked:

1. **Wallet balance** + **vault assets** via `balanceOf` + `convertToAssets`.
2. **Vault yield** by walking `Deposit` / `Withdraw` events (filtered by indexed `owner` / `receiver`).
3. **Airdrop receipts** by walking `Transfer` events from configured distributors to the wallet.

State is persisted in `onchain_vault_state` and `onchain_airdrop_state`; event walking is incremental (each row stores `last_scanned_block`).

### Bank cash

```bash
curl -X PUT http://localhost:4000/cash \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $API_AUTH_TOKEN' \
  -d '{"platform":"KBANK","label":"Kasikorn Savings","amount_thb":184500}'
```

## Architecture

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Binance API │───▶│                  │◀───│ Yahoo / Finnhub  │
│ (read-only) │    │                  │    │ (stock + FX)     │
└─────────────┘    │                  │    └──────────────────┘
                   │   Postgres       │
┌─────────────┐    │                  │    ┌──────────────────┐
│ Gmail / PDF │───▶│  positions       │───▶│ React app        │
│ (DIME mail) │    │  trades          │    │ (TanStack Query  │
└─────────────┘    │  deposits        │    │  polls /portfolio │
                   │  prices          │    │  every 30s, on  │
┌─────────────┐    │  prices_daily    │    │  desktop + PWA  │
│ World Chain │───▶│  fx_rates        │    │  on phone)      │
│  (viem RPC) │    │  fx_daily        │    └──────────────────┘
└─────────────┘    │  portfolio_      │
                   │  snapshots       │
                   │  onchain_*       │
                   └──────────────────┘
                         ▲
                         │
                   node-cron jobs
                   (5m / 1h / 6h / nightly)
```

**Hot path (`GET /portfolio`)** reads exclusively from Postgres — no live outbound calls. Cron refreshes the tables (5 min for prices + Binance balances + on-chain, 1 h for FX, 6 h for portfolio snapshots, nightly for the chart-cache warm). `?refresh=1` forces a live pull on demand.

## Production deployment

| Layer | Host | URL |
|---|---|---|
| API | Fly.io (`investment-consolidation` app, region `sin`, single 512 MB shared-cpu-1x machine) | `https://investment-consolidation.fly.dev` |
| Web | Cloudflare Pages (`consolidate-web`, auto-builds from `main`) | `https://consolidate-web.pages.dev` |
| Postgres | Neon (`ap-southeast-1`, pooler endpoint) | via `DATABASE_URL` Fly secret |
| PWA | Same CF Pages bundle, installed via "Add to Home Screen" on mobile Safari | (no separate distribution) |

Slash commands `/check-prod`, `/deploy-api`, and `/onchain-state` (Claude Code skills) drive the prod-side workflows.

## Commands

```bash
bun install
bun run dev                         # api + web concurrently
bun run dev:api                     # api only
bun run dev:web                     # web only
bun run typecheck                   # api + web
bun run build                       # typecheck + vite build

bun run --filter @consolidate/api test                  # vitest
bun run --filter @consolidate/api test -- cost-basis    # single file

bun run import:dime -- path/to/dime-export.csv
bun run --filter @consolidate/api cli -- import-binance
bun run --filter @consolidate/api cli -- dime-mail
```

## True-baht PNL math

Every trade row carries `fx_at_trade` (USDTHB at the moment of the fill). The pure function at `apps/api/src/services/cost-basis.ts` is the single source of truth:

```
BUY:   costUSD += qty × price
       costTHB += qty × price × fx_at_trade

SELL:  sellFrac = sellQty / qty
       cost basis scales by (1 − sellFrac), realized PNL banked

market_USD     = qty_now × price_now
market_THB     = market_USD × fx_now
pnl_USD        = market_USD − cost_basis_USD               (asset appreciation)
pnl_THB        = market_THB − cost_basis_THB               (what you actually gain in baht)
fx_contrib_THB = cost_basis_USD × (fx_now − fx_locked_avg) (pure currency effect)
market_pnl_THB = pnl_THB − fx_contrib_THB
```

The dashboard's True PNL · breakdown card splits **Market PNL** from **FX contribution** so you see which half of the gain is real vs a currency move. There's a second cost-basis method alongside weighted-avg: **FIFO**, computed by `aggregateTradesFIFO`. The "DIME view" toggle on desktop and the cost-view switch on mobile render FIFO so figures reconcile with what the DIME app shows.

Tests cover BUY-only, partial sell, full sell + rebuy, DIV, SELL-before-BUY, and FIFO — `apps/api/src/services/cost-basis.test.ts`.

## Roadmap notes

- **Trading attribution in THB** would need `fx_at_trade` to flow through the per-sell counterfactual math; today the metric is USD-only to avoid the spot-rate fudge.
- **Benchmark overlay** (e.g. SPY total return on the same deposit stream) is the single highest-leverage chart still missing.
- **Tax-aware reporting** for Thailand's 2024 foreign-source-income remittance rules — the data is all there (deposits + withdrawals + realized PNL); just needs a tile.
