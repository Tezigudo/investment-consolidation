---
description: Open a PR, run code-review, address any high-confidence issues, re-review, merge, then (if the API changed) deploy. End-to-end ship flow.
---

End-to-end "open PR → review → fix → re-review → merge → deploy" workflow for this repo. Use when the user says "ship it", "/ship", "PR + merge + deploy", or similar.

## Preconditions

- Working tree must be CLEAN before starting. If not clean, stop and tell the user — never auto-commit unrelated changes.
- A feature branch must be checked out (NOT `main`). If on `main`, stop and tell the user.
- Required env: `gh`, `flyctl`, network access to GitHub + Fly. Local `.env` must have `API_AUTH_TOKEN` (only used for local-vs-prod verification).

## Pre-deploy gates (MUST run before opening the PR)

`typecheck` alone is not enough — the Fly Dockerfile runs the full `bun run build`, and the Depot remote builders have less memory than a dev laptop, so they will OOM (exit 137) on code that compiles locally with `tsc --noEmit` but exceeds the build's memory profile. Always:

1. `bun run typecheck` — must exit 0.
2. `bun run --filter @consolidate/api test` — must exit 0.
3. `bun run build` — must exit 0. This emulates exactly what the Dockerfile does (`bun run --filter @consolidate/api build && bun run --filter @consolidate/web build`).

If any of these fail, stop and surface the error. Do not open a PR with broken builds.

## Steps

1. **Check state.** Run `git status -sb` and `git rev-parse --abbrev-ref HEAD`. Confirm:
   - Working tree clean (no `M`/`??` lines).
   - Branch is not `main`.
   - Branch has been pushed (`git rev-parse --abbrev-ref @{upstream}` resolves). If not pushed, `git push -u origin <branch>`.

2. **Open the PR.** If no PR exists for the current branch (`gh pr view --json number 2>/dev/null`), open one:
   - Title: from the latest commit's subject (`git log -1 --format=%s`), truncated to <70 chars if needed.
   - Body: a `## Summary` + `## Test plan` block, derived from the commit messages on the branch (`git log main..HEAD --format=%B`). Include the `🤖 Generated with [Claude Code]` footer.
   - Use HEREDOC for the body so multi-line markdown survives.

3. **Wait for required CI.** Check `gh pr view <N> --json mergeStateStatus,statusCheckRollup`. If `mergeStateStatus` is `BLOCKED` due to failing checks, stop and surface the failure URL. If `BEHIND`, rebase the branch on `main` first. If `CLEAN`/`UNSTABLE` with all checks green, proceed.

4. **Run code review.** Invoke the `/code-review:code-review` skill on the PR. Wait for the review comment to land on the PR (it will be a comment starting with `### Code review`).

5. **Address issues, if any.**
   - If the review says "No issues found" → skip to step 6.
   - If the review found issues: for each, decide:
     - Is it a real bug or CLAUDE.md violation with a clear fix? If yes, fix it without asking. Commit with `fix(review): <issue-shorthand>`, push.
     - Ambiguous, design-question, or risky? Stop and ask the user.
   - After all auto-fixable issues are pushed, re-invoke `/code-review:code-review` on the same PR. Loop until the latest review says "No issues found" OR you've looped 3 times (then stop and ask).

6. **Merge.** `gh pr merge <N> --squash --delete-branch` (Tezigudo prefers squash; deleting the branch keeps the repo tidy). Confirm with `gh pr view <N> --json state` showing `MERGED`.

7. **Sync local.** `git checkout main && git pull origin main`.

8. **Decide whether to deploy.** Inspect the merged commit's file list: `git show --name-only HEAD`. If ANY file matched:
   - `apps/api/**`
   - `packages/shared/**`
   - `apps/api/src/db/pg-migrations.ts`
   - `apps/api/Dockerfile` or `fly.toml`
   → invoke `/deploy-api` skill. Otherwise (web-only changes auto-deploy via Cloudflare Pages) skip the Fly deploy and just confirm Cloudflare Pages build is queued by checking `gh pr view <N> --json statusCheckRollup`.

9. **Final verification.** After deploy succeeds:
   - `curl -s https://investment-consolidation.fly.dev/health -w "HTTP %{http_code}\n"` → expect 200.
   - If the merged PR included a migration (touched `apps/api/src/db/pg-migrations.ts`), tail Fly logs and grep for `applied migration` to confirm the new version ran on Neon: `flyctl logs -a investment-consolidation --no-tail | grep "applied migration" | tail -5`.

10. **Report.** Tell the user, in 3-5 lines:
    - PR # + merge commit SHA
    - Whether API was deployed (and which migration versions ran, if any)
    - Whether Cloudflare Pages is rebuilding
    - Any caveat from the review (e.g. "skipped 1 ambiguous review nit at score 75")

## Failure modes — never silently work around

- CI failing → stop, surface the URL, ask.
- Code review found issues that don't have a mechanical fix → stop, present to the user, ask.
- Merge conflict on rebase → stop, never `--force` resolve.
- Fly deploy errors → tail logs, present the error, never retry blindly. Never scale memory/count without asking (billing).
- Auth token mismatch when probing prod → just skip the auth-required probe; the user can verify in the browser.

## Safety

- Never push to `main` directly.
- Never `git push --force`.
- Never bypass required reviews or status checks.
- Never `--no-verify` on commits.
- Never `gh pr merge --admin` — if a check fails, fix it.
