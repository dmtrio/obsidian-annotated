#!/usr/bin/env bash
# watch-comments.sh — poll the Annotated actionable endpoint and print
# debounced, deduped event lines. Designed to run under a harness Monitor:
# each stdout line is injected into the agent's context as an event.
# (PLN — Event-Driven Comment Watch, step 5.)
#
# Env contract:
#   WATCH_ENDPOINT   base URL (required), e.g. http://127.0.0.1:27191
#   WATCH_KEY_VAR    NAME of the env var holding the bearer key
#                    (default: ANNOTATED_WATCH_KEY; the key itself is never printed)
#   WATCH_SCOPE      optional folder/note scope (server clamps to the key's fence)
#   WATCH_IDENTITY   optional excludeAuthor override (server defaults to the key's identity)
#   POLL_INTERVAL    seconds between polls (default 30)
#   DEBOUNCE_QUIET   seconds of no-new-arrivals before a batch is emitted (default 50)
#   WATCH_LEDGER     announced-ids ledger path (default: fresh temp file = session-scoped;
#                    a fresh ledger re-announces everything still actionable — that is
#                    the crash-recovery contract, not a bug)
#
# Output lines:
#   new comments on <note_path>: <id>[, <id>...]
#   watch-comments: endpoint unreachable for 5+ minutes (<url>)   [once per outage]
set -u

WATCH_KEY_VAR="${WATCH_KEY_VAR:-ANNOTATED_WATCH_KEY}"
key="${!WATCH_KEY_VAR-}"
if [ -z "${WATCH_ENDPOINT-}" ]; then
  echo "watch-comments: WATCH_ENDPOINT is required" >&2
  exit 2
fi
if [ -z "$key" ]; then
  echo "watch-comments: no key found in \$${WATCH_KEY_VAR}" >&2
  exit 2
fi

POLL_INTERVAL="${POLL_INTERVAL:-30}"
DEBOUNCE_QUIET="${DEBOUNCE_QUIET:-50}"
LEDGER="${WATCH_LEDGER:-$(mktemp -t annotated-watch-ledger.XXXXXX)}"
PENDING="$(mktemp -t annotated-watch-pending.XXXXXX)"
trap 'rm -f "$PENDING"' EXIT
touch "$LEDGER"

url="${WATCH_ENDPOINT%/}/comments/actionable"
query=""
if [ -n "${WATCH_SCOPE-}" ]; then
  query="scope=$(printf %s "$WATCH_SCOPE" | jq -sRr @uri)"
fi
if [ -n "${WATCH_IDENTITY-}" ]; then
  query="${query:+${query}&}excludeAuthor=$(printf %s "$WATCH_IDENTITY" | jq -sRr @uri)"
fi
full_url="$url${query:+?$query}"

tab="$(printf '\t')"
fail_since=0
warned=0
last_new=0

while :; do
  if body="$(curl -fsS --max-time 20 -H "Authorization: Bearer $key" "$full_url" 2>/dev/null)"; then
    fail_since=0
    warned=0
    refs="$(printf '%s' "$body" | jq -r '.[] | [.id, .note_path] | @tsv' 2>/dev/null || true)"
    if [ -n "$refs" ]; then
      while IFS="$tab" read -r id note; do
        [ -n "$id" ] || continue
        if grep -qxF "$id" "$LEDGER"; then continue; fi
        if cut -f1 "$PENDING" | grep -qxF "$id"; then continue; fi
        printf '%s\t%s\n' "$id" "$note" >>"$PENDING"
        last_new="$(date +%s)"
      done <<EOF
$refs
EOF
    fi
  else
    now="$(date +%s)"
    if [ "$fail_since" -eq 0 ]; then fail_since="$now"; fi
    if [ "$warned" -eq 0 ] && [ $((now - fail_since)) -ge 300 ]; then
      echo "watch-comments: endpoint unreachable for 5+ minutes ($url)"
      warned=1
    fi
  fi

  if [ -s "$PENDING" ] && [ "$last_new" -gt 0 ]; then
    now="$(date +%s)"
    if [ $((now - last_new)) -ge "$DEBOUNCE_QUIET" ]; then
      awk -F '\t' '
        !($2 in order) { order[$2] = ++n; notes[n] = $2 }
        { ids[$2] = ids[$2] (ids[$2] ? ", " : "") $1 }
        END { for (i = 1; i <= n; i++) printf "new comments on %s: %s\n", notes[i], ids[notes[i]] }
      ' "$PENDING"
      cut -f1 "$PENDING" >>"$LEDGER"
      : >"$PENDING"
      last_new=0
    fi
  fi

  sleep "$POLL_INTERVAL"
done
