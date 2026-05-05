import { createPublicClient, http, erc20Abi, parseAbi, getAddress, type Address } from 'viem';
import { defineChain } from 'viem';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { getUSDTHB } from './fx.js';

// World Chain mainnet (chain id 480). Defined inline so we don't pull in
// the full viem/chains catalog for one chain.
const worldChain = defineChain({
  id: 480,
  name: 'World Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.ONCHAIN_WLD_RPC] } },
});

// ERC-4626 vault interface (Re7WLD on Morpho is one). Reading
// `convertToAssets(shares)` turns vault shares back into the underlying
// WLD amount the user could redeem right now (i.e. principal + accrued
// yield).
const erc4626Abi = parseAbi([
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
]);

// Balance breakdown so the cron log can show where WLD is sitting.
export interface OnChainWLDSnapshot {
  totalQty: number;
  walletQty: number;
  vaults: { address: string; assetsQty: number; sharesRaw: bigint }[];
}

export async function readWLDPosition(): Promise<OnChainWLDSnapshot> {
  if (!config.onchainEnabled) {
    return { totalQty: 0, walletQty: 0, vaults: [] };
  }
  const wallet = getAddress(config.ONCHAIN_WLD_WALLET);
  const wld = getAddress(config.ONCHAIN_WLD_TOKEN);

  const client = createPublicClient({ chain: worldChain, transport: http() });

  // WLD is 18 decimals like ether — fetch dynamically anyway in case the
  // user points the env at a different token by mistake.
  const decimals = (await client.readContract({
    address: wld,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;
  const scale = 10 ** decimals;

  const walletRaw = (await client.readContract({
    address: wld,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet],
  })) as bigint;
  const walletQty = Number(walletRaw) / scale;

  const vaults: OnChainWLDSnapshot['vaults'] = [];
  for (const vaultAddrStr of config.ONCHAIN_WLD_VAULTS) {
    const vault = getAddress(vaultAddrStr);
    try {
      // Sanity: confirm the vault's underlying asset is WLD. Skip silently
      // if mis-configured — we don't want a typo to dump random tokens
      // into the WLD bag.
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
      if (shares === 0n) {
        vaults.push({ address: vault, assetsQty: 0, sharesRaw: 0n });
        continue;
      }
      const assetsRaw = (await client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: 'convertToAssets',
        args: [shares],
      })) as bigint;
      vaults.push({ address: vault, assetsQty: Number(assetsRaw) / scale, sharesRaw: shares });
    } catch (e) {
      console.warn(`[onchain] vault ${vault} read failed:`, (e as Error).message);
    }
  }

  const totalQty = walletQty + vaults.reduce((s, v) => s + v.assetsQty, 0);
  return { totalQty, walletQty, vaults };
}

// Persist the aggregated WLD position into `positions` so the hot-path
// portfolio aggregator picks it up the same way Binance positions do.
// Cost basis is whatever the user set in env (default $0 — airdrop).
export async function refreshOnChainWLD(): Promise<OnChainWLDSnapshot> {
  const snap = await readWLDPosition();
  if (!config.onchainEnabled) return snap;

  if (snap.totalQty <= 0) {
    // No WLD held — clear any stale row to avoid showing 0-qty zombies.
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

  // One-shot cleanup: an early version of the chart wired OnChain →
  // 'stock', which made the modal fetch WLD from Yahoo (junk data for a
  // non-stock ticker). Purge any such rows so the next chart open
  // re-fetches WLD from Binance klines like other crypto. Idempotent —
  // becomes a no-op once the bad data is gone.
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
