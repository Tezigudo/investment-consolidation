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
State: No changes or facts in this session.

# === END COGNILAYER ===
