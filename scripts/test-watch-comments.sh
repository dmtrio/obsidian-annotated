#!/usr/bin/env bash
# Acceptance test for watch-comments.sh (PLN step 5) against a fake endpoint:
#   - one debounced batch per burst, grouped by note
#   - already-announced ids never re-emit (including across monitor restarts
#     with the same ledger)
#   - a fresh ledger re-announces everything still actionable
#   - the bearer key never appears in any output
set -u
cd "$(dirname "$0")/.." || exit 1

PORT=27999
STATE="$(mktemp -t watch-test-state.XXXXXX)"
LEDGER="$(mktemp -t watch-test-ledger.XXXXXX)"
OUT="$(mktemp -t watch-test-out.XXXXXX)"
FIXTURE_PID=""
MONITOR_PID=""
fails=0

cleanup() {
  [ -n "$MONITOR_PID" ] && kill "$MONITOR_PID" 2>/dev/null
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  rm -f "$STATE"
}
trap cleanup EXIT

assert_count() { # name, expected, pattern
  actual="$(grep -c "$3" "$OUT")"
  if [ "$actual" -eq "$2" ]; then
    echo "PASS  $1"
  else
    echo "FAIL  $1 (expected $2 matches of '$3', got $actual)"
    fails=$((fails + 1))
  fi
}

start_monitor() {
  WATCH_ENDPOINT="http://127.0.0.1:$PORT" \
  WATCH_KEY_VAR=TEST_WATCH_KEY TEST_WATCH_KEY=watch-fixture-secret \
  POLL_INTERVAL=1 DEBOUNCE_QUIET=2 WATCH_LEDGER="$LEDGER" \
    bash scripts/watch-comments.sh >>"$OUT" 2>&1 &
  MONITOR_PID=$!
}

echo '[]' >"$STATE"
node scripts/watch-fixture.mjs "$PORT" "$STATE" >/dev/null 2>&1 &
FIXTURE_PID=$!
sleep 1

start_monitor

# Phase 1: two ids on one note arrive → exactly one debounced, grouped line
echo '[{"id":"c_a","note_path":"n1.md"},{"id":"c_b","note_path":"n1.md"}]' >"$STATE"
sleep 6
assert_count "one debounced batch, grouped by note" 1 '^new comments on n1.md: c_a, c_b$'

# Phase 2: same actionable set persists → nothing new is emitted
sleep 4
assert_count "already-announced ids never re-emit" 1 '^new comments on'

# Phase 3: a new id on another note → second batch for that note only
echo '[{"id":"c_a","note_path":"n1.md"},{"id":"c_b","note_path":"n1.md"},{"id":"c_c","note_path":"sub/n2.md"}]' >"$STATE"
sleep 6
assert_count "new id triggers a new batch" 1 '^new comments on sub/n2.md: c_c$'

# Phase 4: restart with the SAME ledger → silence
kill "$MONITOR_PID" 2>/dev/null; wait "$MONITOR_PID" 2>/dev/null; MONITOR_PID=""
lines_before="$(grep -c '^new comments on' "$OUT")"
start_monitor
sleep 5
assert_count "restart with same ledger stays silent" "$lines_before" '^new comments on'

# Phase 5: restart with a FRESH ledger → re-announces everything actionable
kill "$MONITOR_PID" 2>/dev/null; wait "$MONITOR_PID" 2>/dev/null; MONITOR_PID=""
LEDGER="$(mktemp -t watch-test-ledger2.XXXXXX)"
start_monitor
sleep 6
assert_count "fresh ledger re-announces unactioned comments (crash recovery)" 2 '^new comments on n1.md: c_a, c_b$'

# Secrets must never appear in output
assert_count "no secret in any output" 0 'watch-fixture-secret'

echo "---"
[ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILURES"
exit "$fails"
