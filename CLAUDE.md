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

- `apps/api/` — Fastify + TypeScript + Postgres (`pg`). Migrations, Binance HMAC client, CSV importer, portfolio aggregator, on-chain (viem) integrations, cron jobs, CLI.
- `apps/web/` — Vite + React 18 + TypeScript + TanStack Query. One desktop-grid dashboard.
- `apps/mobile/` — Expo SDK 54 + React Native 0.81 + Expo Router + TanStack Query. iOS-first local-use app for the same data, talks to the API over LAN/Tailscale.
- `packages/shared/` — cross-workspace types (`PortfolioSnapshot`, `EnrichedPosition`, `TradeRow`, `Currency`, …). **Contract between api, web, AND mobile — keep all three sides importing from here, never duplicate the shapes.** Must stay ESM-clean (no Node built-ins) so Metro bundles it cleanly.
- `design/` — original Claude Design HTML/JSX prototype, kept for visual reference only. Do not import from it.

## Commands

```bash
bun install
bun run dev             # concurrent api (:4000) + web (:5173)
bun run dev:api         # api only
bun run dev:web         # web only
bun run dev:mobile      # Expo on LAN; phone scans QR via Camera → Expo Go
bun run dev:mobile:tunnel  # Expo via tunnel (use off-LAN; slower)
bun run typecheck       # all three workspaces in parallel
bun run build           # typecheck + vite build (mobile is not part of build)
bun run --filter @consolidate/api test            # vitest
bun run --filter @consolidate/api test -- cost-basis  # single test file
bun run import:dime -- path/to/dime-export.csv
```

Bun is the package manager and workspace task runner. The API runs under Node via `tsx watch` for dev / `node dist/server.js` for start.

The web dev server proxies `/api/*` → `http://127.0.0.1:4000` (see `apps/web/vite.config.ts`). The frontend always calls `/api/...` — never hard-code `localhost:4000` into components.

The API binds to `0.0.0.0` (not `127.0.0.1`) so the mobile client on a real iPhone can reach it. Don't change this back unless mobile is gone.

Mobile-specific scripts must `cd apps/mobile && bun run …` rather than `bun run --filter`; the workspace filter wraps stdout and swallows the Expo QR ASCII output.

## Hot-path discipline (important)

`GET /portfolio` must read **only from Postgres** (`positions`, `prices`, `fx_rates`, `cash`, `trades` tables). Both the web dashboard AND the mobile app poll this endpoint every 30s via TanStack Query — making it hit Binance/Finnhub/Yahoo on every request will rate-limit you fast.

Live outbound calls live in:

- `src/jobs/scheduler.ts` — cron: prices every 5min, Binance holdings every 5min, FX every hour, on-chain WLD every 5min, plus a one-shot warm-up on server boot.
- `buildSnapshot({ refresh: true })` — triggered only by `GET /portfolio?refresh=1` (manual "refresh now" escape hatch).

When adding a new data source, put the fetch in a cron job that writes to Postgres, and add a read-from-DB code path in `src/services/portfolio.ts`. Don't add fetches to request handlers.

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

`apps/api/src/config.ts` loads `.env` from the **repo root** (not `apps/api/.env`). Vite does the same via `envDir: root` in its config. Add **API/web** env vars to the root `.env`.

The mobile app is an exception — Expo loads `apps/mobile/.env.local` separately. Only `EXPO_PUBLIC_*` vars are exposed to the bundle. The one that matters is `EXPO_PUBLIC_API_URL` (the LAN/Tailscale URL of the Mac running the API). The user can also override it at runtime via Settings → Server.

## Database

Postgres runs via `docker-compose.yml` (service `db`, port 5432, db/user/password all `consolidate`). Connection string in `DATABASE_URL`. In production this points at Neon (Singapore region, free tier with auto-suspend). Migrations run on first import of `./db/client.js`; add new ones as appended entries in `apps/api/src/db/pg-migrations.ts` with a monotonically increasing `version` — never edit applied migrations in place. Current head is **migration 8** (`onchain_airdrop_state`).

Tables carry intent: `deposits.fx_locked`, `trades.fx_at_trade`, and `positions.cost_basis_thb` are the FX-locked columns. If you add a new source of trades, make sure it writes an FX rate per row or the whole PNL model fails silently.

`positions.updated_at` is a **`BIGINT`** Unix-ms timestamp, not a `timestamptz`. Pass `Date.now()` not `new Date()`. (Same for `cash.updated_at`.)

## Default to local

Ad-hoc verification ("test the endpoint", "check the API", "curl it") defaults to **local** dev: `http://localhost:4000` for the API, `http://localhost:5173` for the web (which proxies `/api` to :4000), the local docker-compose Postgres for SQL. Only hit Fly / Cloudflare / Neon when the user explicitly says "prod" / "Fly" / names the deployed URL, OR invokes one of the named-prod slash commands (`/check-prod`, `/deploy-api`, `/onchain-state`).

Touching prod silently burns deploy quota, can race with cron-modifying state, and can mask local bugs. If unsure which environment the user means, ask one clarifying line before running.

## Production deployment

| Layer | Host | URL |
|---|---|---|
| API | Fly.io (`investment-consolidation` app, region `sin`, single 512MB shared-cpu-1x machine) | `https://investment-consolidation.fly.dev` |
| Web | Cloudflare Pages (`consolidate-web`, auto-builds from `main` branch) | `https://consolidate-web.pages.dev` |
| Postgres | Neon (`ap-southeast-1`, pooler endpoint) | via `DATABASE_URL` Fly secret |
| Mobile | Expo Go on the user's phone (no store distribution) | LAN/Tailscale to API |

**Fly machine sizing:** 256MB OOM-killed during the boot warmup (Binance + price + on-chain crons fire close together). 512MB is the floor — set in `fly.toml` (`[[vm]]` section).

**Fly Dockerfile gotchas:**
- `oven/bun:1.2.21-alpine` is pinned exactly (not `1.2-alpine`) because lockfile compatibility differs between Bun patch versions.
- `apps/mobile/package.json` MUST be copied into the build context even though mobile isn't deployed — Bun walks the workspace globs (`apps/*`) and refuses `--frozen-lockfile` if any workspace manifest is missing. `.dockerignore` excludes the mobile source but includes the manifest via `!apps/mobile/package.json`.
- Runtime is `node:24.15.0-alpine` (not Bun) to match the local dev runtime.

**Cloudflare Pages config:**
- Root directory: `apps/web`, build command: `bun run build`, output: `dist`.
- Pages env vars (`Settings → Variables and Secrets`) are **runtime** vars only — they DO NOT reach the Vite build container. The production API URL is therefore hardcoded as a fallback in `apps/web/src/api/client.ts` (`PROD_DEFAULT`); user can still override at runtime via the Tweaks panel → API URL field.
- `wrangler.toml` at `apps/web/` is required to stop wrangler 4.x from running workspace-detection at the repo root.

**Auth model:**
- API requires `Authorization: Bearer <token>` on every route except `/health`.
- Token is generated once (`openssl rand -hex 32`) and set as the `API_AUTH_TOKEN` Fly secret. The same token is pasted by the user into:
  - **Web** — bottom-right ⚙ "Tweaks" panel, persisted to `localStorage['consolidate.apiToken']`.
  - **Mobile** — Settings tab → API auth token field, persisted via AsyncStorage.
- The Dashboard's loading/error states render a skeleton + top-right Toast (not a black screen), and the Tweaks gear is always reachable from the App level so the user can configure auth even when the API errors.

## On-chain (World Chain) tracking

`src/services/onchain.ts` reads via viem's public client against World Chain (chain ID 480). Three things are tracked per (wallet, configured token):

1. **Wallet balance** + **vault assets** — `balanceOf` + `convertToAssets` calls per ERC-4626 vault listed in `ONCHAIN_WLD_VAULTS`. Persisted in `positions` so the hot-path aggregator picks it up.
2. **Vault yield** — Walks `Deposit` (filtered by indexed `owner = wallet`) and `Withdraw` (filtered by indexed `receiver = wallet`) events for each vault. Lifetime yield = `(withdrawals + current) − deposits`. Persisted in `onchain_vault_state`.
3. **Airdrop receipts** — Walks ERC-20 `Transfer` events on the token where `from = any configured distributor` and `to = wallet`. Persisted in `onchain_airdrop_state`. Default distributor is the Worldcoin weekly grant (`0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`); add more via the comma-separated `ONCHAIN_WLD_AIRDROP_SOURCES` env var.

**Withdraw filter is by `receiver`, not `owner`.** Morpho's bundler contracts pull the user's vault shares via approval and call `vault.redeem(shares, receiver=user, owner=bundler)`. Filtering by `owner` misses ~95% of withdrawals.

**Event walking is incremental.** Each state row stores `last_scanned_block`; subsequent ticks scan only the new ~150 blocks per 5-min cron. First-ever scan walks all ~30M blocks at 1M blocks/chunk (~6s) — public Alchemy's response-size cap is fine because the wallet/source topic filter shrinks responses to a handful of logs.

The `/symbols/:sym/history` endpoint folds vault yield into the existing `earned` aggregate (alongside Binance Earn rewards) and exposes airdrop separately as `airdrop`. Web (`PriceModal`) and mobile (position screen) each render a dedicated "Airdrop received" card when non-zero.

## Chart cache (price-history)

`src/services/price-history.ts` warms the daily-window `prices_daily` cache for held symbols. A boot-time + nightly cron (`02:30 UTC`) calls `warmDailyHistoryBatch` for every distinct symbol in `trades` plus on-chain priced symbols. Skips symbols whose cache is already current. Result: chart-modal open is ~600ms warm vs ~15s cold.

If you change the chart's default window (`CHART_HISTORY_DAYS` in `scheduler.ts`), the warm function will pick up the new range on next run.

## Mobile app (apps/mobile)

Expo SDK 54 + Expo Router + RN 0.81. Local-use only — no App Store, no auth beyond Face ID at app open.

Key constraints:

- **Networking is LAN-direct.** No Vite-style proxy; the API base URL is the full Mac LAN/Tailscale URL. Set in `apps/mobile/.env.local` or via Settings → Server. Phone must reach the Mac on port 4000.
- **Metro is monorepo-aware.** `metro.config.js` adds the workspace root to `watchFolders` and walks `nodeModulesPaths` upward; don't simplify it.
- **`@consolidate/shared` must stay ESM-clean** (no Node built-ins) — Metro will choke otherwise.
- **Charts are hand-rolled SVG** in `src/components/PriceChart.tsx`. We avoided `victory-native` to keep the dep tree slim. If you need pinch-zoom or crosshair tooltips later, swap to victory-native CartesianChart with the Skia backend.
- **`pnlPctTHB` from `EnrichedPosition` is unsafe to display directly.** After partial sells, `costTHB` shrinks proportionally and the % explodes (e.g. 3,000% on a position that's been mostly sold). Use `safePctDisplay(pnl, base)` from `src/lib/format.ts` with `base = costTHB - realizedUSD * fxLocked` (≈ original net cash invested) — it clamps to ±999% and returns null when meaningless (zero cost basis, fully closed positions).
- **Price `kind` mapping** in `src/lib/kind.ts`: `DIME → stock`, everything else (Binance, OnChain) → `crypto`. Same logic the web's PriceModal uses. Don't infer it from the symbol.
- **FlashList v2** removed `estimatedItemSize` — don't add it back.
- **Don't run mobile via `bun run --filter`.** The workspace runner buffers stdout and eats the Expo QR. The root scripts cd into `apps/mobile` directly.

## Design prototype

`design/` contains the original HTML/JSX prototype from Claude Design. It uses in-browser Babel + React from CDN and a `DesignCanvas` pan/zoom wrapper — do not port that wrapper. Treat the prototype as a visual spec; the production components in `apps/web/src/components/` are the real source.

# === COGNILAYER (auto-generated, do not delete) ===

## CogniLayer v4 Active
Persistent memory + code intelligence is ON.
ON FIRST USER MESSAGE in this session, briefly tell the user:
  'CogniLayer v4 active — persistent memory is on. Type /cognihelp for available commands.'
Say it ONCE, keep it short, then continue with their request.

## MEMORY HIERARCHY (CRITICAL — ALWAYS FOLLOW)

You have TWO memory systems. Use BOTH, but with clear priority:

### PRIMARY: CogniLayer MCP (memory_search / memory_write)
- ALWAYS use FIRST for both reading and writing
- FTS5 + vector search, heat decay, 14 fact types, code intelligence
- On-demand — loads only relevant facts (~500 tokens instead of tens of thousands)
- Store here: decisions, gotchas, patterns, error_fixes, api_contracts, procedures

### SECONDARY (FALLBACK): Auto-memory (MEMORY.md files)
- Use when CogniLayer MCP is unavailable, fails, or returns empty
- MEMORY.md is loaded into context ALWAYS at session start — keep it SHORT (max 30 lines)
- Store here only: critical user feedback, deploy workflow, 1-line pointers to CogniLayer

### RULES:
1. READING: memory_search(query) FIRST → if empty/error → read MEMORY.md files
2. WRITING: memory_write() ALWAYS → ALSO to auto-memory ONLY if critical user feedback/rule
3. NEVER duplicate content — if fact is in CogniLayer, put only a 1-line pointer in auto-memory
4. Auto-memory MEMORY.md is an INDEX, not a database — format: `- [topic] → /recall keyword`
5. If CogniLayer MCP fails → USE auto-memory as base and alert user about MCP issue

### CHECK (every ~10 prompts or before ending work):
- Did I save new findings to memory_write()? If not → save NOW
- Is session bridge current? If not → session_bridge(action="save")
- DO NOT wait for end of session — save continuously, session may crash

## Tools — HOW TO WORK

FIRST RUN ON A PROJECT:
When DNA shows "[new session]" or "[first session]":
1. Run /onboard — indexes project docs (PRD, README), builds initial memory
2. Run code_index() — builds AST index for code intelligence
Both are one-time. After that, updates are incremental.
If file_search or code_search return empty → these haven't been run yet.

UNDERSTAND FIRST (before making changes):
- memory_search(query) → what do we know? Past bugs, decisions, gotchas
- code_context(symbol) → how does the code work? Callers, callees, dependencies
- file_search(query) → search project docs (PRD, README) without reading full files
- code_search(query) → find where a function/class is defined
Use BOTH memory + code tools for complete picture. They are fast — call in parallel.

BEFORE RISKY CHANGES (mandatory):
- Renaming, deleting, or moving a function/class → code_impact(symbol) FIRST
- Changing a function's signature or return value → code_impact(symbol) FIRST
- Modifying shared utilities used across multiple files → code_impact(symbol) FIRST
- ALSO: memory_search(symbol) → check for related decisions or known gotchas
Both required. Structure tells you what breaks, memory tells you WHY it was built that way.

AFTER COMPLETING WORK:
- memory_write(content) → save important discoveries immediately
  (error_fix, gotcha, pattern, api_contract, procedure, decision)
- session_bridge(action="save", content="Progress: ...; Open: ...")
DO NOT wait for /harvest — session may crash.

## SHORT SESSIONS = BETTER PERFORMANCE
- With 200K context, session compresses sooner → faster responses
- CogniLayer bridge + memory_search replaces lost history for ~2K tokens
- After completing a coherent block of work: save bridge → suggest user starts new session
- Use /compact when session grows and work is not yet done

SUBAGENT MEMORY PROTOCOL:
When spawning Agent tool for research or exploration:
- Include in prompt: synthesize findings into consolidated memory_write(content, type, tags="subagent,<task-topic>") facts
  Assign a descriptive topic tag per subagent (e.g. tags="subagent,auth-review", tags="subagent,perf-analysis")
- Do NOT write each discovery separately — group related findings into cohesive facts
- Write to memory as the LAST step before return, not incrementally — saves turns and tokens
- Each fact must be self-contained with specific details (file paths, values, code snippets)
- When findings relate to specific files, include domain and source_file for better search and staleness detection
- End each fact with 'Search: keyword1, keyword2' — keywords INSIDE the fact survive context compaction
- Record significant negative findings too (e.g. 'no rate limiting exists in src/api/' — prevents repeat searches)
- Return: actionable summary (file paths, function names, specific values) + what was saved + keywords for memory_search
- If MCP tools unavailable or fail → include key findings directly in return text as fallback
- Launch subagents as foreground (default) for reliable MCP access — user can Ctrl+B to background later
Why: without this protocol, subagent returns dump all text into parent context (40K+ tokens).
With protocol, findings go to DB and parent gets ~500 token summary + on-demand memory_search.

BEFORE DEPLOY/PUSH:
- verify_identity(action_type="...") → mandatory safety gate
- If BLOCKED → STOP and ask the user
- If VERIFIED → READ the target server to the user and request confirmation

## VERIFY-BEFORE-ACT
When memory_search returns a fact marked ⚠ STALE:
1. Read the source file and verify the fact still holds
2. If changed → update via memory_write
3. NEVER act on STALE facts without verification

## Process Management (Windows)
- NEVER use `taskkill //F //IM node.exe` — kills ALL Node.js INCLUDING Claude Code CLI!
- Use: `npx kill-port PORT` or find PID via `netstat -ano | findstr :PORT` then `taskkill //F //PID XXXX`

## Git Rules
- Commit often, small atomic changes. Format: "[type] what and why"
- commit = Tier 1 (do it yourself). push = Tier 3 (verify_identity).

## Project DNA: investing-consolidate
Stack: unknown
Style: [unknown]
Structure: apps, design, packages, secrets
Deploy: [NOT SET]
Active: [new session]
Last: [first session]

## Session Continuity
Files: apps/web/src/vite-env.d.ts, apps/web/src/api/client.ts, apps/api/package.json, .dockerignore, Dockerfile

# === END COGNILAYER ===
