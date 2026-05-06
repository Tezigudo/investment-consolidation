---
description: Probe World Chain RPC to find sender contracts of token transfers to a wallet (for adding new ONCHAIN_WLD_AIRDROP_SOURCES entries).
argument-hint: [wallet=0x... token=0x...]
---

Default to the WLD token (`0x2cFc85d8E48F8EAB294be644d9E25C3030863003`) and the configured wallet from `.env` (`ONCHAIN_WLD_WALLET`) unless the user passes overrides via `$ARGUMENTS`.

Run this Python one-liner in Bash to bucket lifetime token-in events by sender:

```bash
python3 << 'EOF'
import json, urllib.request
from collections import defaultdict
WALLET = '0xdda19cc4e949751bd1abed99262c4ee85f56c71a'  # override from $ARGUMENTS if present
TOKEN  = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003'
RPC    = 'https://worldchain-mainnet.g.alchemy.com/public'
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
WALLET_TOPIC = '0x' + '0' * 24 + WALLET[2:].lower()
def call(m, p):
    req = urllib.request.Request(RPC, data=json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(), headers={'Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())
latest = int(call('eth_blockNumber', [])['result'], 16)
end, all_events = latest, []
while end > 0:
    start = max(0, end - 1_000_000 + 1)
    res = call('eth_getLogs', [{'address': TOKEN, 'fromBlock': hex(start), 'toBlock': hex(end), 'topics': [TRANSFER, None, WALLET_TOPIC]}])
    if 'result' in res: all_events.extend(res['result'])
    if start <= 1: break
    end = start - 1
by_sender = defaultdict(lambda: [0, 0.0])
for l in all_events:
    sender = '0x' + l['topics'][1][-40:]
    by_sender[sender][0] += 1
    by_sender[sender][1] += int(l['data'], 16) / 1e18
print(f'Total inflows: {len(all_events)} events')
for s, (cnt, total) in sorted(by_sender.items(), key=lambda x: -x[1][1]):
    print(f'  {s}: {cnt} txs, {total:.4f} tokens')
EOF
```

Once results are in, **classify each sender** for the user:
- The Re7 vault address (already in `ONCHAIN_WLD_VAULTS`) = vault withdrawals (already tracked, skip)
- High-frequency tiny payouts = likely Worldcoin grant / drop distributor — candidate for `ONCHAIN_WLD_AIRDROP_SOURCES`
- Mid-frequency mid-size = could be staking/CEX deposit; ask user to inspect on worldscan
- Single large = one-off transfer; not an airdrop

Report the table + your classification + the worldscan URLs (`https://worldscan.org/address/<addr>`) the user can click to verify before adding to `ONCHAIN_WLD_AIRDROP_SOURCES`.

If the wallet/token defaults are clearly wrong (e.g. user passed something else in `$ARGUMENTS`), substitute their values into the script before running.
