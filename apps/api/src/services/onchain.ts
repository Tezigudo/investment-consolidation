import { createPublicClient, http, erc20Abi, parseAbi, getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import { defineChain } from 'viem';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { getUSDTHB } from './fx.js';

// Public Alchemy caps eth_getLogs at 10k blocks unless responses are
// small; the wallet/source topic filter shrinks them enough to push 1M.
const LOG_CHUNK_BLOCKS = 1_000_000n;

const worldChain = defineChain({
  id: 480,
  name: 'World Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.ONCHAIN_WLD_RPC] } },
});

const erc4626Abi = parseAbi([
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
]);

const erc4626DepositEvent = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
);
const erc4626WithdrawEvent = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
);

const erc20TransferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

function toTokenQty(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = Number(raw % scale) / Number(scale);
  return Number(whole) + frac;
}

// Balance breakdown so the cron log can show where WLD is sitting.
export interface OnChainWLDSnapshot {
  totalQty: number;
  walletQty: number;
  vaults: { address: string; assetsQty: number; sharesRaw: bigint }[];
  // Wrong if vault shares were transferred between wallets — the
  // transfer reads as free yield/loss with no on-chain way to tell.
  earnedQty: number;
}

interface VaultStateRow {
  symbol: string;
  wallet: string;
  vault: string;
  decimals: number;
  totalDepositsRaw: bigint;
  totalWithdrawalsRaw: bigint;
  currentAssetsRaw: bigint;
  lastScannedBlock: bigint;
}

async function readVaultState(wallet: string, vault: string): Promise<VaultStateRow | undefined> {
  const { rows } = await pool.query<{
    symbol: string;
    wallet: string;
    vault: string;
    decimals: number;
    total_deposits_raw: string;
    total_withdrawals_raw: string;
    current_assets_raw: string;
    last_scanned_block: string;
  }>(
    `SELECT symbol, wallet, vault, decimals,
            total_deposits_raw, total_withdrawals_raw, current_assets_raw, last_scanned_block
     FROM onchain_vault_state WHERE wallet = $1 AND vault = $2`,
    [wallet.toLowerCase(), vault.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    symbol: r.symbol,
    wallet: r.wallet,
    vault: r.vault,
    decimals: r.decimals,
    totalDepositsRaw: BigInt(r.total_deposits_raw),
    totalWithdrawalsRaw: BigInt(r.total_withdrawals_raw),
    currentAssetsRaw: BigInt(r.current_assets_raw),
    lastScannedBlock: BigInt(r.last_scanned_block),
  };
}

async function upsertVaultState(row: VaultStateRow): Promise<void> {
  await pool.query(
    `INSERT INTO onchain_vault_state(
       symbol, wallet, vault, decimals,
       total_deposits_raw, total_withdrawals_raw, current_assets_raw,
       last_scanned_block, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (wallet, vault) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals,
       total_deposits_raw = EXCLUDED.total_deposits_raw,
       total_withdrawals_raw = EXCLUDED.total_withdrawals_raw,
       current_assets_raw = EXCLUDED.current_assets_raw,
       last_scanned_block = EXCLUDED.last_scanned_block,
       updated_at = EXCLUDED.updated_at`,
    [
      row.symbol,
      row.wallet.toLowerCase(),
      row.vault.toLowerCase(),
      row.decimals,
      row.totalDepositsRaw.toString(),
      row.totalWithdrawalsRaw.toString(),
      row.currentAssetsRaw.toString(),
      row.lastScannedBlock.toString(),
      Date.now(),
    ],
  );
}

// Withdraw filter: Morpho's bundler owns the shares at burn time and
// only `receiver` reliably matches the user's wallet — owner-filter
// misses ~95% of withdrawals.
async function walkVaultEvents(
  client: PublicClient,
  vault: Address,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ depositedRaw: bigint; withdrawnRaw: bigint }> {
  let depositedRaw = 0n;
  let withdrawnRaw = 0n;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : cursor + LOG_CHUNK_BLOCKS - 1n;
    const [deposits, withdrawals] = await Promise.all([
      client.getLogs({
        address: vault,
        event: erc4626DepositEvent,
        args: { owner: wallet },
        fromBlock: cursor,
        toBlock: chunkEnd,
      }),
      client.getLogs({
        address: vault,
        event: erc4626WithdrawEvent,
        args: { receiver: wallet },
        fromBlock: cursor,
        toBlock: chunkEnd,
      }),
    ]);
    for (const log of deposits) depositedRaw += (log.args.assets as bigint) ?? 0n;
    for (const log of withdrawals) withdrawnRaw += (log.args.assets as bigint) ?? 0n;
    cursor = chunkEnd + 1n;
  }
  return { depositedRaw, withdrawnRaw };
}

export async function readOnchainEarnForSymbol(
  symbol: string,
): Promise<{ qty: number; vaultCount: number } | null> {
  const { rows } = await pool.query<{
    decimals: number;
    total_deposits_raw: string;
    total_withdrawals_raw: string;
    current_assets_raw: string;
  }>(
    `SELECT decimals, total_deposits_raw, total_withdrawals_raw, current_assets_raw
     FROM onchain_vault_state WHERE symbol = $1`,
    [symbol],
  );
  if (!rows.length) return null;
  let earnedQty = 0;
  let vaultCount = 0;
  for (const r of rows) {
    const deposits = BigInt(r.total_deposits_raw);
    const withdrawals = BigInt(r.total_withdrawals_raw);
    const current = BigInt(r.current_assets_raw);
    // Lifetime yield = (withdrawn + still held) − deposited; clamp at
    // zero so vault losses don't show as negative "earnings".
    const totalOut = withdrawals + current;
    const yieldRaw = totalOut > deposits ? totalOut - deposits : 0n;
    earnedQty += toTokenQty(yieldRaw, r.decimals);
    vaultCount += 1;
  }
  return { qty: earnedQty, vaultCount };
}

interface AirdropStateRow {
  symbol: string;
  wallet: string;
  source: string;
  decimals: number;
  totalReceivedRaw: bigint;
  eventCount: number;
  firstTs: number;
  lastTs: number;
  lastScannedBlock: bigint;
}

async function readAirdropState(wallet: string, source: string): Promise<AirdropStateRow | undefined> {
  const { rows } = await pool.query<{
    symbol: string;
    wallet: string;
    source: string;
    decimals: number;
    total_received_raw: string;
    event_count: number;
    first_ts: string;
    last_ts: string;
    last_scanned_block: string;
  }>(
    `SELECT symbol, wallet, source, decimals,
            total_received_raw, event_count, first_ts, last_ts, last_scanned_block
     FROM onchain_airdrop_state WHERE wallet = $1 AND source = $2`,
    [wallet.toLowerCase(), source.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    symbol: r.symbol,
    wallet: r.wallet,
    source: r.source,
    decimals: r.decimals,
    totalReceivedRaw: BigInt(r.total_received_raw),
    eventCount: Number(r.event_count),
    firstTs: Number(r.first_ts),
    lastTs: Number(r.last_ts),
    lastScannedBlock: BigInt(r.last_scanned_block),
  };
}

async function upsertAirdropState(row: AirdropStateRow): Promise<void> {
  await pool.query(
    `INSERT INTO onchain_airdrop_state(
       symbol, wallet, source, decimals,
       total_received_raw, event_count, first_ts, last_ts,
       last_scanned_block, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (wallet, source) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals,
       total_received_raw = EXCLUDED.total_received_raw,
       event_count = EXCLUDED.event_count,
       first_ts = EXCLUDED.first_ts,
       last_ts = EXCLUDED.last_ts,
       last_scanned_block = EXCLUDED.last_scanned_block,
       updated_at = EXCLUDED.updated_at`,
    [
      row.symbol,
      row.wallet.toLowerCase(),
      row.source.toLowerCase(),
      row.decimals,
      row.totalReceivedRaw.toString(),
      row.eventCount,
      row.firstTs,
      row.lastTs,
      row.lastScannedBlock.toString(),
      Date.now(),
    ],
  );
}

async function walkAirdropEvents(
  client: PublicClient,
  token: Address,
  source: Address,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ receivedRaw: bigint; count: number; firstTs: number; lastTs: number }> {
  let receivedRaw = 0n;
  let count = 0;
  let firstBlk = 0n;
  let lastBlk = 0n;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : cursor + LOG_CHUNK_BLOCKS - 1n;
    const logs = await client.getLogs({
      address: token,
      event: erc20TransferEvent,
      args: { from: source, to: wallet },
      fromBlock: cursor,
      toBlock: chunkEnd,
    });
    for (const log of logs) {
      receivedRaw += (log.args.value as bigint) ?? 0n;
      count += 1;
      const blk = log.blockNumber as bigint;
      if (firstBlk === 0n || blk < firstBlk) firstBlk = blk;
      if (blk > lastBlk) lastBlk = blk;
    }
    cursor = chunkEnd + 1n;
  }
  let firstTs = 0;
  let lastTs = 0;
  if (count > 0) {
    const [first, last] = await Promise.all([
      client.getBlock({ blockNumber: firstBlk }),
      firstBlk === lastBlk
        ? client.getBlock({ blockNumber: firstBlk })
        : client.getBlock({ blockNumber: lastBlk }),
    ]);
    firstTs = Number(first.timestamp) * 1000;
    lastTs = Number(last.timestamp) * 1000;
  }
  return { receivedRaw, count, firstTs, lastTs };
}

async function refreshAirdrops(
  client: PublicClient,
  token: Address,
  wallet: Address,
  decimals: number,
  symbol: string,
  latestBlock: bigint,
): Promise<void> {
  for (const sourceStr of config.ONCHAIN_WLD_AIRDROP_SOURCES) {
    const source = getAddress(sourceStr);
    try {
      const prev = await readAirdropState(wallet, source);
      const fromBlock = prev ? prev.lastScannedBlock + 1n : 0n;
      let receivedRaw = prev?.totalReceivedRaw ?? 0n;
      let count = prev?.eventCount ?? 0;
      let firstTs = prev?.firstTs ?? 0;
      let lastTs = prev?.lastTs ?? 0;
      if (fromBlock <= latestBlock) {
        const fresh = await walkAirdropEvents(client, token, source, wallet, fromBlock, latestBlock);
        receivedRaw += fresh.receivedRaw;
        count += fresh.count;
        if (fresh.firstTs > 0 && (firstTs === 0 || fresh.firstTs < firstTs)) firstTs = fresh.firstTs;
        if (fresh.lastTs > lastTs) lastTs = fresh.lastTs;
      }
      await upsertAirdropState({
        symbol,
        wallet,
        source,
        decimals,
        totalReceivedRaw: receivedRaw,
        eventCount: count,
        firstTs,
        lastTs,
        lastScannedBlock: latestBlock,
      });
    } catch (e) {
      console.warn(`[onchain] airdrop source ${source} walk failed:`, (e as Error).message);
    }
  }
}

export async function readOnchainAirdropForSymbol(
  symbol: string,
): Promise<{ qty: number; count: number; firstTs: number; lastTs: number; sources: number } | null> {
  const { rows } = await pool.query<{
    decimals: number;
    total_received_raw: string;
    event_count: number;
    first_ts: string;
    last_ts: string;
  }>(
    `SELECT decimals, total_received_raw, event_count, first_ts, last_ts
     FROM onchain_airdrop_state WHERE symbol = $1`,
    [symbol],
  );
  if (!rows.length) return null;
  let qty = 0;
  let count = 0;
  let firstTs = 0;
  let lastTs = 0;
  for (const r of rows) {
    qty += toTokenQty(BigInt(r.total_received_raw), r.decimals);
    count += Number(r.event_count);
    const fts = Number(r.first_ts);
    const lts = Number(r.last_ts);
    if (fts > 0 && (firstTs === 0 || fts < firstTs)) firstTs = fts;
    if (lts > lastTs) lastTs = lts;
  }
  return { qty, count, firstTs, lastTs, sources: rows.length };
}

export async function readWLDPosition(): Promise<OnChainWLDSnapshot> {
  if (!config.onchainEnabled) {
    return { totalQty: 0, walletQty: 0, vaults: [], earnedQty: 0 };
  }
  const wallet = getAddress(config.ONCHAIN_WLD_WALLET);
  const wld = getAddress(config.ONCHAIN_WLD_TOKEN);

  const client = createPublicClient({ chain: worldChain, transport: http() }) as PublicClient;
  const latestBlock = await client.getBlockNumber();

  const decimals = (await client.readContract({
    address: wld,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;

  const walletRaw = (await client.readContract({
    address: wld,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet],
  })) as bigint;
  const walletQty = toTokenQty(walletRaw, decimals);

  const vaults: OnChainWLDSnapshot['vaults'] = [];
  for (const vaultAddrStr of config.ONCHAIN_WLD_VAULTS) {
    const vault = getAddress(vaultAddrStr);
    try {
      // Skip vaults whose underlying isn't WLD so a typo can't dump
      // random tokens into the WLD bag.
      const underlying = (await client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: 'asset',
      })) as Address;
      if (underlying.toLowerCase() !== wld.toLowerCase()) {
        console.warn(
          `[onchain] vault ${vault} underlying ${underlying} != WLD ${wld}; skipping`,
        );
        continue;
      }

      const shares = (await client.readContract({
        address: vault,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      })) as bigint;
      const assetsRaw = shares === 0n
        ? 0n
        : ((await client.readContract({
            address: vault,
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [shares],
          })) as bigint);
      vaults.push({
        address: vault,
        assetsQty: toTokenQty(assetsRaw, decimals),
        sharesRaw: shares,
      });

      // Walk every tick — even when shares==0 — to keep withdrawals
      // and current_assets in sync with the lifetime-yield formula.
      const prev = await readVaultState(wallet, vault);
      const fromBlock = prev ? prev.lastScannedBlock + 1n : 0n;
      let depositedRaw = prev?.totalDepositsRaw ?? 0n;
      let withdrawnRaw = prev?.totalWithdrawalsRaw ?? 0n;
      if (fromBlock <= latestBlock) {
        const events = await walkVaultEvents(client, vault, wallet, fromBlock, latestBlock);
        depositedRaw += events.depositedRaw;
        withdrawnRaw += events.withdrawnRaw;
      }
      await upsertVaultState({
        symbol: 'WLD',
        wallet,
        vault,
        decimals,
        totalDepositsRaw: depositedRaw,
        totalWithdrawalsRaw: withdrawnRaw,
        currentAssetsRaw: assetsRaw,
        lastScannedBlock: latestBlock,
      });
    } catch (e) {
      console.warn(`[onchain] vault ${vault} read failed:`, (e as Error).message);
    }
  }

  if (config.ONCHAIN_WLD_AIRDROP_SOURCES.length > 0) {
    try {
      await refreshAirdrops(client, wld, wallet, decimals, 'WLD', latestBlock);
    } catch (e) {
      console.warn('[onchain] airdrop refresh failed:', (e as Error).message);
    }
  }

  const earned = await readOnchainEarnForSymbol('WLD');
  const earnedQty = earned?.qty ?? 0;

  const totalQty = walletQty + vaults.reduce((s, v) => s + v.assetsQty, 0);
  return { totalQty, walletQty, vaults, earnedQty };
}

export async function refreshOnChainWLD(): Promise<OnChainWLDSnapshot> {
  const snap = await readWLDPosition();
  if (!config.onchainEnabled) return snap;

  if (snap.totalQty <= 0 && snap.earnedQty <= 0) {
    // Keep the row alive while there's earned yield so the chart's
    // "Total earned" stat survives a withdraw → redeposit cycle.
    await pool.query(
      "DELETE FROM positions WHERE platform = 'OnChain' AND symbol = 'WLD'",
    );
    return snap;
  }

  const fx = await getUSDTHB();
  const totalCostUSD = config.ONCHAIN_WLD_COST_USD;
  const avgUSD = totalCostUSD / snap.totalQty;
  const costTHB = totalCostUSD * fx.rate;

  await pool.query(
    `INSERT INTO positions(platform, symbol, name, qty, avg_cost_usd, cost_basis_thb, sector, updated_at)
     VALUES ('OnChain', 'WLD', 'Worldcoin (on-chain)', $1, $2, $3, 'Crypto', $4)
     ON CONFLICT (platform, symbol) DO UPDATE SET
       name = EXCLUDED.name,
       qty = EXCLUDED.qty,
       avg_cost_usd = EXCLUDED.avg_cost_usd,
       cost_basis_thb = EXCLUDED.cost_basis_thb,
       sector = EXCLUDED.sector,
       updated_at = EXCLUDED.updated_at`,
    [snap.totalQty, avgUSD, costTHB, Date.now()],
  );

  // One-shot purge of pre-fix Yahoo-sourced WLD price rows; idempotent
  // once cleared. Drop after a few weeks of clean prod runs.
  const purged = await pool.query(
    `DELETE FROM prices_daily WHERE asset = 'WLD' AND source = 'yahoo-chart'`,
  );
  if ((purged.rowCount ?? 0) > 0) {
    await pool.query(`DELETE FROM prices_daily_fetch WHERE asset = 'WLD'`);
    console.log(
      `[onchain] cleared ${purged.rowCount} stale Yahoo-sourced WLD prices_daily rows + fetch cooldown`,
    );
  }

  return snap;
}
