// Shared Binance HTTP layer.
//
// Every Binance call in the app goes through this module so that we
// have exactly one rate-limit policy to reason about:
//
//  - All requests are serialized through a single queue (concurrency 1).
//  - A minimum interval is enforced between any two requests.
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

// 1100ms keeps /api/v3/myTrades (weight 20) under the 1200/min budget —
// 500ms would trip 429s on sustained myTrades probing. Lighter endpoints
// (klines weight 2) aren't hurt meaningfully by the slower floor.
const MIN_INTERVAL_MS = 1100;
const EXPONENTIAL_CAP_MS = 60_000;
const LOUD_RETRY_AFTER_MS = 5 * 60_000;
const MAX_RETRIES = 6;
const RETRIABLE = new Set([418, 429]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
let pauseUntil = 0;
// Set when we see a long Retry-After (likely 418 IP ban). Callers
// catch + continue per-endpoint, which without this flag would let
// every subsequent call fire and take its own 418. Fast-failing from
// the queue turns one ban into one log line plus a quick unwind.
let bannedUntil = 0;
let banMessage = '';

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (Date.now() < bannedUntil) {
    return Promise.reject(new Error(banMessage));
  }
  const task = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(pauseUntil - now, lastRequestAt + MIN_INTERVAL_MS - now, 0);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // doFetch is re-invoked each attempt so signed requests can
    // re-stamp `timestamp` — a stale timestamp (>recvWindow old) is
    // itself a hard error from Binance.
    const res = await enqueue(doFetch);
    if (res.ok) return (await res.json()) as T;

    const body = await res.text();
    if (!RETRIABLE.has(res.status) || attempt === MAX_RETRIES) {
      throw new Error(`Binance ${path} ${res.status}: ${body}`);
    }

    const retryAfterSec = Number(res.headers.get('retry-after'));
    const hasHeader = Number.isFinite(retryAfterSec) && retryAfterSec > 0;
    const backoffMs = hasHeader
      ? retryAfterSec * 1000
      : Math.min(EXPONENTIAL_CAP_MS, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

    if (backoffMs > LOUD_RETRY_AFTER_MS) {
      banMessage = `Binance ${path} ${res.status}: Retry-After ${Math.round(backoffMs / 1000)}s — likely IP banned. Stopping so you can re-run after the cooldown.`;
      bannedUntil = Date.now() + backoffMs;
      throw new Error(banMessage);
    }

    pauseUntil = Math.max(pauseUntil, Date.now() + backoffMs);
    console.warn(
      `[binance] ${res.status} on ${path}, pausing queue ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
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
