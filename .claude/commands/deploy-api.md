---
description: Deploy the API to Fly.io and verify the health endpoint comes back 200.
---

Deploy the Fly.io API and verify it.

1. Run `flyctl deploy -a investment-consolidation` and watch for "Visit your newly deployed app at..." line. If the build errors out, surface the actual error to the user — do NOT retry blindly.
2. Once deploy succeeds, sleep ~10s for the new machine to start, then `curl -s -o /dev/null -w "HTTP %{http_code}\n" https://investment-consolidation.fly.dev/health`.
3. If health returns 200, report success with the deploy + health verification.
4. If health returns 502 / 5xx, immediately tail logs: `flyctl logs -a investment-consolidation --no-tail 2>&1 | tail -40` and report what you see (most likely OOM if memory was lowered, or an unhandled startup error).

Do NOT scale memory or count without asking — those affect billing.
