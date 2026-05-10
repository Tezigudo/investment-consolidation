#!/usr/bin/env bash
# PreToolUse hook for `git commit` — blocks the commit if .env or
# secrets/* files are staged. Earlier in the project history, .env
# (with live Binance keys) was almost committed accidentally; this
# stops a repeat.
#
# Reads the tool input as JSON on stdin (the harness contract for
# PreToolUse hooks). If the staged file list contains anything
# sensitive, exit 2 with a message — the harness shows it to Claude
# AND aborts the tool call.

set -euo pipefail

# Only act on `git commit` invocations. Other git commands pass through.
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# What's actually staged? `--cached` only — unstaged files are fine.
staged=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$staged" ]; then
  exit 0
fi

# Patterns that should never be committed. .env wildcard catches
# .env, .env.local, .env.production, etc. but lets .env.example through.
bad=$(printf '%s\n' "$staged" | grep -E '(^|/)\.env($|\.[^e]|\.e[^x])|^secrets/|/secrets/|\.pem$|\.key$|gmail-credentials\.json|gmail-token\.json' || true)

if [ -n "$bad" ]; then
  cat >&2 <<EOF
[secret-guard] Refusing to commit — these staged files look sensitive:
$bad

If a match is a false positive (e.g. .env.example), unstage and recommit
specific files explicitly. To bypass intentionally, run the git commit
yourself outside Claude.
EOF
  exit 2
fi

exit 0
