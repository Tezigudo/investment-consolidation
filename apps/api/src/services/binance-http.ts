// Shared Binance HTTP layer.
//
// Every Binance call in the app goes through this module so that we
// have exactly one rate-limit policy to reason about:
//
//  - All requests are serialized through a single queue (concurrency 1).
//  - A minimum interval is enforced between any two requests.
//  - After every response, we read the X-MBX-USED-WEIGHT-1m header
//    and dynamically back off when approaching the 1200/min limit.
//    This is the primary throttle — the fixed minimum interval is
//    just a floor to avoid burst mode on light endpoints.
//  - On 429 / 418, the Retry-After header pauses the whole queue —
//    not just the failing call — so parallel retries don't immediately
//    re-trigger the limit.
//  - A Retry-After longer than LOUD_RETRY_AFTER_MS is treated as an IP
//    ban and thrown rather than slept through, because blocking the
//    import for minutes-to-hours is worse than bailing with a clear
//    message. The importer uses cursors, so re-running later resumes.

import crypto from 'node:crypto';
import { config } from '../config.js';

const BASE = 'https://api.binance.com';

// Floor between any two requests. The weight-aware pacer
// (applyWeightBackpressure) is the primary throttle for /api/* endpoints.
// SAPI endpoints (/sapi/*) have opaque per-UID rate limits that don't
// report weight headers, so they rely more heavily on this floor.
// Empirically /sapi/v1/fiat/orders allows ~4 requests per 30s window.
const MIN_INTERVAL_MS_API = 300;   // /api/* (weight-tracked)
const MIN_INTERVAL_MS_SAPI = 8000; // /sapi/* (opaque UID rate limit, ~4 req/30s)

// When a SAPI endpoint 429s with retry-after=0, there's no way to know
// the exact cooldown. Empirically the window is ~30s, so we jump
// straight to a 30s pause instead of wasting retries on 1s/2s/4s
// backoffs that will all fail.
const SAPI_429_FLOOR_MS = 30_000;
const EXPONENTIAL_CAP_MS = 60_000;
const LOUD_RETRY_AFTER_MS = 5 * 60_000;
const MAX_RETRIES = 6;
const RETRIABLE = new Set([418, 429]);

// ── Weight-aware dynamic pacing ──────────────────────────────
// Binance returns X-MBX-USED-WEIGHT-1m on every response (even 429s).
// We read it after each call and proactively slow down before hitting
// the hard limit — this prevents the 429 → retry → 429 spiral.
const WEIGHT_LIMIT = 1200;
const WEIGHT_SOFT_CEILING = 900; // start adding delay above this

const DEBUG = !!process.env.DEBUG_BINANCE;
let requestSeq = 0; // monotonic counter for log correlation

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
let lastSapiRequestAt = 0;
let pauseUntil = 0;
// Set when we see a long Retry-After (likely 418 IP ban). Callers
// catch + continue per-endpoint, which without this flag would let
// every subsequent call fire and take its own 418. Fast-failing from
// the queue turns one ban into one log line plus a quick unwind.
let bannedUntil = 0;
let banMessage = '';

// Read the used-weight header from any Binance response (success or
// error) and push pauseUntil forward if we're approaching the limit.
// Binance uses different headers for different API families:
//   /api/*  → X-MBX-USED-WEIGHT-1m
//   /sapi/* → X-SAPI-USED-IP-WEIGHT-1M
// Both share the same 1200/min IP weight pool, so we read whichever
// header is present and take the max.
function readUsedWeight(res: Response): number {
  const mbx = Number(res.headers.get('x-mbx-used-weight-1m'));
  const sapi = Number(res.headers.get('x-sapi-used-ip-weight-1m'));
  const used = Math.max(
    Number.isFinite(mbx) ? mbx : 0,
    Number.isFinite(sapi) ? sapi : 0,
  );
  return used;
}

function applyWeightBackpressure(res: Response): void {
  const used = readUsedWeight(res);
  if (used <= 0) return;

  if (used >= WEIGHT_SOFT_CEILING) {
    // Scale delay from ~5s at the soft ceiling to ~60s at the hard limit.
    const fraction = Math.min(
      (used - WEIGHT_SOFT_CEILING) / (WEIGHT_LIMIT - WEIGHT_SOFT_CEILING),
      1,
    );
    // Quadratic curve: gentle near 900, aggressive near 1200.
    const delayMs = Math.round(5_000 + fraction * fraction * 55_000);
    const target = Date.now() + delayMs;
    if (target > pauseUntil) {
      pauseUntil = target;
      console.warn(
        `[binance] weight ${used}/${WEIGHT_LIMIT}, pausing ${Math.round(delayMs / 1000)}s`,
      );
    }
  }
}

function enqueue<T>(fn: () => Promise<T>, isSapi: boolean): Promise<T> {
  if (Date.now() < bannedUntil) {
    return Promise.reject(new Error(banMessage));
  }
  const task = chain.then(async () => {
    const now = Date.now();
    // SAPI endpoints have stricter per-UID rate limits, enforce a
    // longer floor between calls to /sapi/* paths.
    const minInterval = isSapi ? MIN_INTERVAL_MS_SAPI : MIN_INTERVAL_MS_API;
    const lastRelevant = isSapi
      ? Math.max(lastRequestAt, lastSapiRequestAt)
      : lastRequestAt;
    const wait = Math.max(pauseUntil - now, lastRelevant + minInterval - now, 0);
    if (wait > 0) await sleep(wait);
    const t = Date.now();
    lastRequestAt = t;
    if (isSapi) lastSapiRequestAt = t;
    return fn();
  });
  chain = task.catch(() => undefined);
  return task;
}

function sign(qs: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

function buildQuery(params: Record<string, string | number>): URLSearchParams {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
}

async function runWithRetries<T>(path: string, doFetch: () => Promise<Response>): Promise<T> {
  const isSapi = path.startsWith('/sapi');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // doFetch is re-invoked each attempt so signed requests can
    // re-stamp `timestamp` — a stale timestamp (>recvWindow old) is
    // itself a hard error from Binance.
    const seq = ++requestSeq;
    const res = await enqueue(doFetch, isSapi);

    // Read used-weight header on EVERY response (success, 429, etc.)
    // and proactively slow down before we hit the hard limit.
    applyWeightBackpressure(res);

    if (DEBUG) {
      const weight = readUsedWeight(res);
      console.log(
        `[binance:${seq}] ${res.status} ${path} weight=${weight}/${WEIGHT_LIMIT}`,
      );
    }

    if (res.ok) return (await res.json()) as T;

    const body = await res.text();
    if (!RETRIABLE.has(res.status) || attempt === MAX_RETRIES) {
      throw new Error(`Binance ${path} ${res.status}: ${body}`);
    }

    // Log all rate-limit headers on 429/418 for diagnosis.
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const weight = readUsedWeight(res);
    console.warn(
      `[binance:${seq}] ${res.status} on ${path}, ` +
      `weight=${weight}/${WEIGHT_LIMIT}, ` +
      `retry-after=${res.headers.get('retry-after') ?? 'none'} ` +
      `(attempt ${attempt + 1}/${MAX_RETRIES})`,
    );

    const hasHeader = Number.isFinite(retryAfterSec) && retryAfterSec > 0;
    let backoffMs: number;
    if (hasHeader) {
      backoffMs = retryAfterSec * 1000;
    } else if (isSapi) {
      // SAPI endpoints don't send useful retry-after headers. Their
      // per-UID rate limit window is ~30s, so any backoff shorter
      // than that will just burn retries. Jump straight to 30s.
      backoffMs = SAPI_429_FLOOR_MS;
    } else {
      backoffMs = Math.min(EXPONENTIAL_CAP_MS, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
    }

    if (backoffMs > LOUD_RETRY_AFTER_MS) {
      banMessage = `Binance ${path} ${res.status}: Retry-After ${Math.round(backoffMs / 1000)}s — likely IP banned. Stopping so you can re-run after the cooldown.`;
      bannedUntil = Date.now() + backoffMs;
      throw new Error(banMessage);
    }

    pauseUntil = Math.max(pauseUntil, Date.now() + backoffMs);
    // No sleep here — the next enqueue() reads pauseUntil and waits.
  }
  throw new Error(`Binance ${path}: exhausted retries`);
}

export async function binanceSignedGet<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  if (!config.binanceEnabled) {
    throw new Error(
      'Binance is not configured. Set BINANCE_API_KEY and BINANCE_API_SECRET in .env',
    );
  }
  return runWithRetries<T>(path, () => {
    const qs = buildQuery({ ...params, timestamp: Date.now(), recvWindow: 10_000 });
    qs.append('signature', sign(qs.toString(), config.BINANCE_API_SECRET));
    return fetch(`${BASE}${path}?${qs.toString()}`, {
      headers: { 'X-MBX-APIKEY': config.BINANCE_API_KEY },
    });
  });
}

export async function binancePublicGet<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  return runWithRetries<T>(path, () => {
    const qs = buildQuery(params);
    const url = qs.toString() ? `${BASE}${path}?${qs.toString()}` : `${BASE}${path}`;
    return fetch(url);
  });
}
