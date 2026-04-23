// Mock portfolio data — realistic numbers for a Thai retail investor
// who holds US stocks via DIME and crypto via Binance.
// Cost basis is recorded in BOTH USD (market) AND THB (FX-locked at deposit).

const FX = {
  // Current FX rates
  USDTHB: 36.42,
  USDTUSD: 1.0002,
  BTCUSD: 94850,
  ETHUSD: 3420,
};

const HOLDINGS = {
  dime: [
    { sym: 'NVDA', name: 'NVIDIA Corp',        qty: 18,  avgUSD: 412.50, priceUSD: 578.20, fxLocked: 34.80, sector: 'Semis' },
    { sym: 'GOOGL', name: 'Alphabet Inc Cl A', qty: 24,  avgUSD: 138.20, priceUSD: 172.40, fxLocked: 35.10, sector: 'Tech' },
    { sym: 'AAPL', name: 'Apple Inc',          qty: 15,  avgUSD: 178.90, priceUSD: 221.50, fxLocked: 35.40, sector: 'Tech' },
    { sym: 'MSFT', name: 'Microsoft Corp',     qty: 10,  avgUSD: 342.10, priceUSD: 428.90, fxLocked: 34.95, sector: 'Tech' },
    { sym: 'TSLA', name: 'Tesla Inc',          qty: 8,   avgUSD: 248.00, priceUSD: 189.30, fxLocked: 36.20, sector: 'Auto'  },
    { sym: 'AMZN', name: 'Amazon.com Inc',     qty: 12,  avgUSD: 152.40, priceUSD: 198.80, fxLocked: 35.80, sector: 'Retail'},
    { sym: 'VOO',  name: 'Vanguard S&P 500',   qty: 6,   avgUSD: 412.00, priceUSD: 524.30, fxLocked: 34.60, sector: 'ETF'   },
  ],
  binance: [
    { sym: 'BTC',  name: 'Bitcoin',  qty: 0.1842, avgUSD: 61240, priceUSD: FX.BTCUSD, fxLocked: 35.60, sector: 'Crypto' },
    { sym: 'ETH',  name: 'Ethereum', qty: 2.84,   avgUSD: 2840,  priceUSD: FX.ETHUSD, fxLocked: 35.90, sector: 'Crypto' },
    { sym: 'SOL',  name: 'Solana',   qty: 48.2,   avgUSD: 98.40, priceUSD: 164.20,    fxLocked: 36.00, sector: 'Crypto' },
    { sym: 'DOGE', name: 'Dogecoin', qty: 12400,  avgUSD: 0.082, priceUSD: 0.134,     fxLocked: 35.50, sector: 'Crypto' },
    { sym: 'USDT', name: 'Tether',   qty: 1240.5, avgUSD: 1.00,  priceUSD: 1.0002,    fxLocked: 36.10, sector: 'Stable' },
  ],
  bank: [
    { sym: 'KBANK', name: 'Kasikorn Savings', qty: 1,   avgUSD: 0, priceUSD: 0, fxLocked: 36.42, sector: 'Cash', thbBalance: 184500 },
  ],
};

// Compute per-position metrics for both USD and THB views.
// THB cost basis uses FX rate at time of deposit — that's the "true PNL" in baht.
function enrich(pos) {
  const marketUSD = pos.qty * pos.priceUSD;
  const costUSD = pos.qty * pos.avgUSD;
  const pnlUSD = marketUSD - costUSD;
  const pnlPct = costUSD > 0 ? (pnlUSD / costUSD) * 100 : 0;

  // THB valuation: current market * current FX
  const marketTHB = marketUSD * FX.USDTHB;
  // THB cost: qty * avgUSD * FX_at_deposit (locked)
  const costTHB = costUSD * pos.fxLocked;
  const pnlTHB = marketTHB - costTHB;
  const pnlPctTHB = costTHB > 0 ? (pnlTHB / costTHB) * 100 : 0;

  // FX contribution to THB PNL
  const fxContribTHB = costUSD * (FX.USDTHB - pos.fxLocked);

  return { ...pos, marketUSD, costUSD, pnlUSD, pnlPct, marketTHB, costTHB, pnlTHB, pnlPctTHB, fxContribTHB };
}

const PORTFOLIO = {
  dime: HOLDINGS.dime.map(enrich),
  binance: HOLDINGS.binance.map(enrich),
  bank: HOLDINGS.bank.map(p => ({ ...enrich(p), marketTHB: p.thbBalance || 0, marketUSD: (p.thbBalance || 0) / FX.USDTHB })),
};

function totals(list) {
  return list.reduce((a, p) => ({
    marketUSD: a.marketUSD + p.marketUSD,
    marketTHB: a.marketTHB + p.marketTHB,
    costUSD: a.costUSD + (p.costUSD || 0),
    costTHB: a.costTHB + (p.costTHB || 0),
    pnlUSD: a.pnlUSD + (p.pnlUSD || 0),
    pnlTHB: a.pnlTHB + (p.pnlTHB || 0),
    fxContribTHB: a.fxContribTHB + (p.fxContribTHB || 0),
  }), { marketUSD: 0, marketTHB: 0, costUSD: 0, costTHB: 0, pnlUSD: 0, pnlTHB: 0, fxContribTHB: 0 });
}

const TOTALS = {
  dime: totals(PORTFOLIO.dime),
  binance: totals(PORTFOLIO.binance),
  bank: totals(PORTFOLIO.bank),
  all: totals([...PORTFOLIO.dime, ...PORTFOLIO.binance, ...PORTFOLIO.bank]),
};

// Synthetic time-series for charts (180 days, ending today)
function genSeries(startUSD, endUSD, startTHB, endTHB, days = 180) {
  const out = [];
  const now = Date.now();
  let u = startUSD, t = startTHB;
  for (let i = 0; i < days; i++) {
    const p = i / (days - 1);
    const noise = (Math.sin(i * 0.7) * 0.015) + (Math.sin(i * 0.23) * 0.02) + (Math.random() - 0.5) * 0.01;
    u = startUSD + (endUSD - startUSD) * p + endUSD * noise;
    t = startTHB + (endTHB - startTHB) * p + endTHB * noise * 0.9;
    out.push({
      t: now - (days - 1 - i) * 86400000,
      usd: u,
      thb: t,
    });
  }
  return out;
}

const SERIES = genSeries(
  TOTALS.all.costUSD * 0.92,
  TOTALS.all.marketUSD,
  TOTALS.all.costTHB * 0.95,
  TOTALS.all.marketTHB,
  180
);

// FX series — USDTHB moved from ~35.2 to 36.42
const FX_SERIES = (() => {
  const arr = [];
  const now = Date.now();
  for (let i = 0; i < 180; i++) {
    const p = i / 179;
    const base = 35.2 + (36.42 - 35.2) * p;
    const noise = Math.sin(i * 0.4) * 0.12 + (Math.random() - 0.5) * 0.08;
    arr.push({ t: now - (179 - i) * 86400000, rate: base + noise });
  }
  return arr;
})();

// Transactions — last ~20
const TXS = [
  { d: '2026-04-13', plat: 'DIME',    type: 'BUY',    sym: 'NVDA',  qty: 3,   priceUSD: 578.20, fx: 36.42 },
  { d: '2026-04-10', plat: 'Binance', type: 'BUY',    sym: 'BTC',   qty: 0.02, priceUSD: 93200, fx: 36.38 },
  { d: '2026-04-08', plat: 'DIME',    type: 'DIV',    sym: 'AAPL',  qty: 0,   priceUSD: 3.60,   fx: 36.40 },
  { d: '2026-04-02', plat: 'Binance', type: 'BUY',    sym: 'SOL',   qty: 4.2, priceUSD: 158.10, fx: 36.20 },
  { d: '2026-03-28', plat: 'Bank',    type: 'DEPOSIT',sym: 'THB',   qty: 50000, priceUSD: 0,    fx: 36.18 },
  { d: '2026-03-22', plat: 'DIME',    type: 'BUY',    sym: 'VOO',   qty: 2,   priceUSD: 498.40, fx: 35.90 },
  { d: '2026-03-15', plat: 'Binance', type: 'SELL',   sym: 'DOGE',  qty: 2000, priceUSD: 0.142, fx: 35.85 },
  { d: '2026-03-10', plat: 'DIME',    type: 'BUY',    sym: 'GOOGL', qty: 4,   priceUSD: 164.20, fx: 35.75 },
  { d: '2026-03-04', plat: 'DIME',    type: 'DIV',    sym: 'MSFT',  qty: 0,   priceUSD: 7.50,   fx: 35.70 },
  { d: '2026-02-28', plat: 'Binance', type: 'BUY',    sym: 'ETH',   qty: 0.5, priceUSD: 3240,   fx: 35.55 },
  { d: '2026-02-20', plat: 'DIME',    type: 'BUY',    sym: 'AMZN',  qty: 3,   priceUSD: 178.20, fx: 35.40 },
  { d: '2026-02-14', plat: 'DIME',    type: 'SELL',   sym: 'TSLA',  qty: 2,   priceUSD: 212.40, fx: 35.32 },
  { d: '2026-02-05', plat: 'Bank',    type: 'DEPOSIT',sym: 'THB',   qty: 80000, priceUSD: 0,    fx: 35.20 },
];

// Dividends monthly (last 12 months)
const DIVS = [
  { m: 'May', v: 12.4 }, { m: 'Jun', v: 18.2 }, { m: 'Jul', v: 15.8 },
  { m: 'Aug', v: 22.1 }, { m: 'Sep', v: 14.6 }, { m: 'Oct', v: 28.4 },
  { m: 'Nov', v: 19.2 }, { m: 'Dec', v: 24.8 }, { m: 'Jan', v: 16.3 },
  { m: 'Feb', v: 31.5 }, { m: 'Mar', v: 22.9 }, { m: 'Apr', v: 11.1 },
];

// Currency formatting helpers
function fmtUSD(n, opts = {}) {
  const { sign = false, dp = 2 } = opts;
  const abs = Math.abs(n);
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}
function fmtTHB(n, opts = {}) {
  const { sign = false, dp = 0 } = opts;
  const abs = Math.abs(n);
  const s = '฿' + abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}
function fmtUSDT(n, opts = {}) {
  const { sign = false, dp = 2 } = opts;
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + ' ₮';
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return n < 0 ? '−' + s : s;
}
function fmtPct(n, opts = {}) {
  const { sign = true, dp = 2 } = opts;
  const abs = Math.abs(n);
  const s = abs.toFixed(dp) + '%';
  if (sign) return (n >= 0 ? '+' : '−') + s;
  return s;
}
function fmtMoney(n, cur, opts) {
  if (cur === 'THB') return fmtTHB(n, opts);
  if (cur === 'USDT') return fmtUSDT(n, opts);
  return fmtUSD(n, opts);
}

// Per-symbol price history generator. Deterministic per symbol so re-opens match.
function symbolSeries(sym, priceUSD, avgUSD, days = 180) {
  // Seed PRNG from symbol chars so each symbol has a unique shape
  let seed = 0;
  for (let i = 0; i < sym.length; i++) seed = (seed * 31 + sym.charCodeAt(i)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) - 0.5;
  };
  // Start price roughly near avgUSD, end at priceUSD
  const start = avgUSD * (0.85 + Math.abs(rnd()) * 0.15);
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const p = i / (days - 1);
    const trend = start + (priceUSD - start) * p;
    const vol = priceUSD * (0.012 + Math.abs(rnd()) * 0.01);
    const noise = Math.sin(i * 0.32 + seed * 0.0001) * vol + Math.sin(i * 0.11) * vol * 0.7 + rnd() * vol * 1.4;
    out.push({
      t: now - (days - 1 - i) * 86400000,
      price: Math.max(trend + noise, priceUSD * 0.1),
    });
  }
  out[out.length - 1].price = priceUSD; // snap last point to current
  return out;
}

Object.assign(window, {
  FX, PORTFOLIO, TOTALS, SERIES, FX_SERIES, TXS, DIVS,
  fmtUSD, fmtTHB, fmtUSDT, fmtPct, fmtMoney, symbolSeries,
});
