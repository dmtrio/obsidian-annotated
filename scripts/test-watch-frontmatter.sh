#!/usr/bin/env bash
# Acceptance test for watch-frontmatter.sh — against a fake endpoint:
#   - one debounced batch per burst, one line per note+field+value
#   - already-announced dedup keys never re-emit (including across monitor restarts
#     with the same ledger)
#   - a fresh ledger re-announces everything still actionable
#   - the bearer key never appears in any output
#   - comma-arg order-insensitivity: different orderings of args produce the same
#     dedup key and do not re-emit
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
  actual="$(grep -c "$3" "$OUT")" || actual=0
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
  WATCH_TRIGGERS="review,summarize,translate" \
  POLL_INTERVAL=1 DEBOUNCE_QUIET=2 WATCH_LEDGER="$LEDGER" \
    bash scripts/watch-frontmatter.sh >>"$OUT" 2>&1 &
  MONITOR_PID=$!
}

echo '[]' >"$STATE"
node scripts/watch-fixture.mjs "$PORT" "$STATE" >/dev/null 2>&1 &
FIXTURE_PID=$!
sleep 1

start_monitor

# Phase 1: a note with annotated: review emits exactly one line
echo '[{"note_path":"n1.md","field":"annotated","value":"review"}]' >"$STATE"
sleep 6
assert_count "one line emitted for review trigger" 1 '^frontmatter annotated=review on n1.md$'

# Phase 2: the same value persists → no re-emit (ledger dedup)
sleep 4
assert_count "already-announced value never re-emits" 1 '^frontmatter'

# Phase 3: value changes from review to summarize → new line emitted
echo '[{"note_path":"n1.md","field":"annotated","value":"summarize"}]' >"$STATE"
sleep 6
assert_count "value change triggers a new emit" 2 '^frontmatter'
assert_count "new emit is for the new value" 1 '^frontmatter annotated=summarize on n1.md$'

# Phase 4: restart with the SAME ledger → silence
kill "$MONITOR_PID" 2>/dev/null; wait "$MONITOR_PID" 2>/dev/null; MONITOR_PID=""
lines_before="$(grep -c '^frontmatter' "$OUT")"
start_monitor
sleep 5
assert_count "restart with same ledger stays silent" "$lines_before" '^frontmatter'

# Phase 5: restart with a FRESH ledger → re-announces everything actionable
kill "$MONITOR_PID" 2>/dev/null; wait "$MONITOR_PID" 2>/dev/null; MONITOR_PID=""
LEDGER="$(mktemp -t watch-test-ledger2.XXXXXX)"
start_monitor
sleep 6
assert_count "fresh ledger re-announces (crash recovery)" 2 '^frontmatter annotated=summarize on n1.md$'

# Phase 6: comma-arg order-insensitivity
# Write translate/spanish,french for a new note
kill "$MONITOR_PID" 2>/dev/null; wait "$MONITOR_PID" 2>/dev/null; MONITOR_PID=""
LEDGER="$(mktemp -t watch-test-ledger3.XXXXXX)"
echo '[{"note_path":"n2.md","field":"annotated","value":"translate/spanish,french"}]' >"$STATE"
start_monitor
sleep 6
assert_count "translate with spanish,french emits" 1 '^frontmatter annotated=translate/spanish,french on n2.md$'

# Now emit with reversed arg order (french,spanish) — should NOT re-emit due to normalization
echo '[{"note_path":"n2.md","field":"annotated","value":"translate/french,spanish"}]' >"$STATE"
sleep 6
assert_count "reversed arg order produces same dedup key, no re-emit" 1 '^frontmatter annotated=translate'

# Phase 7: a different note with a different trigger emits on first burst
echo '[{"note_path":"n2.md","field":"annotated","value":"translate/french,spanish"},{"note_path":"sub/n3.md","field":"annotated","value":"review"}]' >"$STATE"
sleep 6
assert_count "new note with different trigger emits" 1 '^frontmatter annotated=review on sub/n3.md$'

# Phase 8: secrets must never appear in output
assert_count "no secret in any output" 0 'watch-fixture-secret'

echo "---"
[ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILURES"
exit "$fails"
