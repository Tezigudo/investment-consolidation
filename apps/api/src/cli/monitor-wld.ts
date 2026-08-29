import { createPublicClient, http, erc20Abi, parseAbi, parseAbiItem, getAddress, type Address, type PublicClient } from 'viem';
import { defineChain } from 'viem';

const WALLET = getAddress('0xdda19cc4e949751bd1abed99262c4ee85f56c71a');
const WLD = getAddress('0x2cFc85d8E48F8EAB294be644d9E25C3030863003');
const OLD_VAULT = getAddress('0x348831b46876d3dF2Db98BdEc5E3B4083329Ab9f');
const POLL_MS = 20_000;

const worldChain = defineChain({
  id: 480,
  name: 'World Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://worldchain-mainnet.g.alchemy.com/public'] } },
});

const erc4626Abi = parseAbi([
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function asset() view returns (address)',
]);
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const depositEvent = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)');

const fmt = (raw: bigint) => (Number(raw) / 1e18).toFixed(6);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const now = () => new Date().toISOString().slice(11, 19);

interface Snap {
  block: bigint;
  walletQty: bigint;
  oldVaultShares: bigint;
  oldVaultAssets: bigint;
}

async function snapshot(client: PublicClient): Promise<Snap> {
  const block = await client.getBlockNumber();
  const [walletQty, oldVaultShares] = await Promise.all([
    client.readContract({ address: WLD, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] }) as Promise<bigint>,
    client.readContract({ address: OLD_VAULT, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] }) as Promise<bigint>,
  ]);
  const oldVaultAssets = oldVaultShares === 0n
    ? 0n
    : (await client.readContract({ address: OLD_VAULT, abi: erc4626Abi, functionName: 'convertToAssets', args: [oldVaultShares] }) as bigint);
  return { block, walletQty, oldVaultShares, oldVaultAssets };
}

async function scanRecent(client: PublicClient, fromBlock: bigint, toBlock: bigint, seenVaults: Set<string>): Promise<void> {
  if (fromBlock > toBlock) return;
  const [transfersOut, transfersIn] = await Promise.all([
    client.getLogs({ address: WLD, event: transferEvent, args: { from: WALLET }, fromBlock, toBlock }),
    client.getLogs({ address: WLD, event: transferEvent, args: { to: WALLET }, fromBlock, toBlock }),
  ]);

  for (const log of transfersOut) {
    const to = (log.args.to as Address).toLowerCase();
    const value = log.args.value as bigint;
    console.log(`  ${now()} [OUT] ${fmt(value)} WLD → ${short(to)}  tx=${log.transactionHash}`);
    if (to !== OLD_VAULT.toLowerCase() && to !== WLD.toLowerCase()) {
      seenVaults.add(to);
    }
  }
  for (const log of transfersIn) {
    const from = (log.args.from as Address).toLowerCase();
    const value = log.args.value as bigint;
    const tag = from === OLD_VAULT.toLowerCase() ? '[WITHDRAW from OLD]' : '[IN]';
    console.log(`  ${now()} ${tag} ${fmt(value)} WLD ← ${short(from)}  tx=${log.transactionHash}`);
  }

  // For any candidate contract you sent WLD to, probe whether it looks like
  // an ERC-4626 vault for WLD by calling asset(). If yes, also pull any
  // Deposit event for our wallet in this window to confirm the redeposit.
  for (const candidate of seenVaults) {
    try {
      const underlying = (await client.readContract({
        address: candidate as Address,
        abi: erc4626Abi,
        functionName: 'asset',
      })) as Address;
      if (underlying.toLowerCase() === WLD.toLowerCase()) {
        const depositLogs = await client.getLogs({
          address: candidate as Address,
          event: depositEvent,
          args: { owner: WALLET },
          fromBlock,
          toBlock,
        });
        for (const dl of depositLogs) {
          console.log(`  ${now()} [DEPOSIT into ${short(candidate)}] assets=${fmt(dl.args.assets as bigint)} shares=${fmt(dl.args.shares as bigint)} tx=${dl.transactionHash}`);
        }
      }
    } catch {
      /* not a vault — ignore */
    }
  }
}

async function main() {
  const client = createPublicClient({ chain: worldChain, transport: http() }) as PublicClient;
  let prev = await snapshot(client);
  let cursor = prev.block + 1n;
  const seenVaults = new Set<string>();

  console.log(`[monitor] wallet=${WALLET}`);
  console.log(`[monitor] old vault=${OLD_VAULT}`);
  console.log(`[monitor] start block=${prev.block}  wallet=${fmt(prev.walletQty)} WLD  old-vault-assets=${fmt(prev.oldVaultAssets)} WLD`);
  console.log(`[monitor] polling every ${POLL_MS / 1000}s — Ctrl+C to stop\n`);

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const cur = await snapshot(client);
      if (cur.block === prev.block) continue;

      const walletDelta = cur.walletQty - prev.walletQty;
      const vaultDelta = cur.oldVaultAssets - prev.oldVaultAssets;
      const changed = walletDelta !== 0n || vaultDelta !== 0n;

      if (changed) {
        console.log(`\n[${now()}] block ${cur.block}  Δwallet=${walletDelta >= 0n ? '+' : ''}${fmt(walletDelta)}  Δold-vault=${vaultDelta >= 0n ? '+' : ''}${fmt(vaultDelta)}`);
        console.log(`  wallet=${fmt(cur.walletQty)}  old-vault-assets=${fmt(cur.oldVaultAssets)}  old-vault-shares=${fmt(cur.oldVaultShares)}`);
        await scanRecent(client, cursor, cur.block, seenVaults);
        if (seenVaults.size > 0) {
          console.log(`  → candidate new-vault addresses so far: ${[...seenVaults].map(short).join(', ')}`);
        }
      } else {
        process.stdout.write(`.${cur.block}.`);
      }

      cursor = cur.block + 1n;
      prev = cur;
    } catch (e) {
      console.warn(`[monitor] tick failed: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
