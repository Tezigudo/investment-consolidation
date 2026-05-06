---
description: Quick health triage — API health, recent log lines, deployed web bundle freshness.
---

Run all three checks in parallel (single tool message with three Bash blocks):

1. **API health:**
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" https://investment-consolidation.fly.dev/health
   ```
2. **Recent API log signal** (look for cron tick, errors, OOM):
   ```bash
   flyctl logs -a investment-consolidation --no-tail 2>&1 | grep -iE "onchain|prices|error|oom|killed" | tail -10
   ```
3. **Deployed web bundle hash:**
   ```bash
   curl -sL https://consolidate-web.pages.dev/ | grep -oE '/assets/index-[^"]+\.js' | head -1
   ```

Report concisely:
- API status code + latency
- Anything in logs that looks like a regression (error, OOM, repeated cron failure)
- Bundle hash, and whether it matches the latest local commit (git rev-parse --short HEAD on `apps/web` modifications)

Keep response under 6 lines.
