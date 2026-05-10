#!/usr/bin/env bash
# PostToolUse hook for edits to apps/api/src/db/pg-migrations.ts.
# Project rule: migrations are append-only with monotonically
# increasing `version` numbers. Editing an applied migration in place
# silently breaks every existing database (the version is already in
# `_migrations`, so the change never re-runs).
#
# We extract every `version: <n>` line and check it's a strictly
# increasing sequence. If not, exit 2 to surface the issue to Claude
# AND prevent silent breakage.

set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

case "$file" in
  */apps/api/src/db/pg-migrations.ts) ;;
  *) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

# Pull every "version: N" inside the migrations array and verify the
# sequence is 1,2,3,...,N with no gaps or repeats.
versions=$(grep -E '^[[:space:]]+version:[[:space:]]+[0-9]+,' "$file" | sed -E 's/.*version:[[:space:]]+([0-9]+),/\1/')
if [ -z "$versions" ]; then
  exit 0
fi

prev=0
for v in $versions; do
  expected=$((prev + 1))
  if [ "$v" != "$expected" ]; then
    cat >&2 <<EOF
[migrations] Version sequence broke at: $v (expected $expected after $prev).
Migrations must be append-only with monotonically increasing versions.
Never edit, reorder, or insert into the middle of an applied migration —
the version is already in _migrations on every existing DB and the change
will never re-run. Add a NEW migration entry at the end instead.
EOF
    exit 2
  fi
  prev=$v
done

exit 0
