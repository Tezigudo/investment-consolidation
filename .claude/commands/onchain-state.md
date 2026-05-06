---
description: Inspect the on-chain vault + airdrop state tables on the Fly Postgres (Neon).
---

Query both state tables via `flyctl ssh console`. The SSH command is slow to spin up — combine into a single Bash call:

```bash
flyctl ssh console -a investment-consolidation -C "node -e \"const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); Promise.all([p.query('SELECT symbol,decimals,total_deposits_raw::text,total_withdrawals_raw::text,current_assets_raw::text,last_scanned_block FROM onchain_vault_state'), p.query('SELECT symbol,source,decimals,total_received_raw::text,event_count,first_ts,last_ts,last_scanned_block FROM onchain_airdrop_state')]).then(([v,a])=>{console.log('vault:', JSON.stringify(v.rows,null,2)); console.log('airdrop:', JSON.stringify(a.rows,null,2)); process.exit(0)}).catch(e=>{console.error(e.message); process.exit(1)})\"" 2>&1 | tail -40
```

Then translate the raw NUMERIC values into human-readable WLD using `decimals` (almost always 18):
- `qty = raw / 10^decimals`
- `vault lifetime yield = (withdrawals + current) − deposits` per row
- `airdrop total = sum of raw_received per source` (clamp to 0 if negative)

Report a tight summary:
- Per vault: deposits, withdrawals, current, derived lifetime yield, last scanned block (and how many blocks behind head).
- Per airdrop source: source address, count, total received, date range from `first_ts`/`last_ts` (epoch ms).
- If `last_scanned_block` is more than ~10 blocks behind head, flag it — the cron may be lagging or the RPC errored.
