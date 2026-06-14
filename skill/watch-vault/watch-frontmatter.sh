#!/usr/bin/env bash
# watch-frontmatter.sh — poll the Annotated frontmatter/actionable endpoint and print
# debounced, deduped event lines. Designed to run under a harness Monitor:
# each stdout line is injected into the agent's context as an event.
# Mirrors watch-comments.sh but for frontmatter field triggers.
#
# Env contract:
#   WATCH_ENDPOINT   base URL (required), e.g. http://127.0.0.1:27191
#   WATCH_KEY_VAR    NAME of the env var holding the bearer key
#                    (default: ANNOTATED_WATCH_KEY; the key itself is never printed)
#   WATCH_SCOPE      optional folder/note scope (server clamps to the key's fence)
#   WATCH_TRIGGERS   comma-separated list of trigger values (required),
#                    e.g. review,summarize,translate
#   WATCH_FIELD      field name to monitor (default: annotated)
#   WATCH_SEP        separator within field values (default: /)
#   POLL_INTERVAL    seconds between polls (default 30)
#   DEBOUNCE_QUIET   seconds of no-new-arrivals before a batch is emitted (default 50)
#   WATCH_LEDGER     announced dedup-keys ledger path (default: fresh temp file = session-scoped;
#                    a fresh ledger re-announces everything still actionable — that is
#                    the crash-recovery contract, not a bug)
#
# Output lines:
#   frontmatter <field>=<value> on <note_path>
#   watch-frontmatter: endpoint unreachable for 5+ minutes (<url>)   [once per outage]
set -u

WATCH_KEY_VAR="${WATCH_KEY_VAR:-ANNOTATED_WATCH_KEY}"
key="${!WATCH_KEY_VAR-}"
if [ -z "${WATCH_ENDPOINT-}" ]; then
  echo "watch-frontmatter: WATCH_ENDPOINT is required" >&2
  exit 2
fi
if [ -z "$key" ]; then
  echo "watch-frontmatter: no key found in \$${WATCH_KEY_VAR}" >&2
  exit 2
fi
if [ -z "${WATCH_TRIGGERS-}" ]; then
  echo "watch-frontmatter: WATCH_TRIGGERS is required" >&2
  exit 2
fi

POLL_INTERVAL="${POLL_INTERVAL:-30}"
DEBOUNCE_QUIET="${DEBOUNCE_QUIET:-50}"
WATCH_FIELD="${WATCH_FIELD:-annotated}"
WATCH_SEP="${WATCH_SEP:-/}"
LEDGER="${WATCH_LEDGER:-$(mktemp -t annotated-watch-ledger.XXXXXX)}"
PENDING="$(mktemp -t annotated-watch-pending.XXXXXX)"
trap 'rm -f "$PENDING"' EXIT
touch "$LEDGER"

url="${WATCH_ENDPOINT%/}/frontmatter/actionable"
query="triggers=$(printf %s "$WATCH_TRIGGERS" | jq -sRr @uri)"
query="${query}&field=$(printf %s "$WATCH_FIELD" | jq -sRr @uri)"
query="${query}&sep=$(printf %s "$WATCH_SEP" | jq -sRr @uri)"
if [ -n "${WATCH_SCOPE-}" ]; then
  query="${query}&scope=$(printf %s "$WATCH_SCOPE" | jq -sRr @uri)"
fi
full_url="$url?$query"

tab="$(printf '\t')"
unitSep="$(printf '\x1f')"
fail_since=0
warned=0
last_new=0

normalize_value() {
  local value="$1"
  local sep="$2"
  # If value contains the separator, split at first separator,
  # sort the comma-separated arg parts, and rejoin.
  if printf '%s' "$value" | grep -q "$(printf '%s\n' "$sep" | sed 's/[[\.*^$/]/\\&/g')"; then
    local root arg sorted_arg
    root="${value%%${sep}*}"
    arg="${value#*${sep}}"
    # Sort comma-separated parts
    sorted_arg="$(printf '%s' "$arg" | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')"
    printf '%s\n' "${root}${sep}${sorted_arg}"
  else
    printf '%s\n' "$value"
  fi
}

while :; do
  if body="$(curl -fsS --max-time 20 -H "Authorization: Bearer $key" "$full_url" 2>/dev/null)"; then
    fail_since=0
    warned=0
    refs="$(printf '%s' "$body" | jq -r '.[] | [.note_path, .field, .value] | @tsv' 2>/dev/null || true)"
    if [ -n "$refs" ]; then
      while IFS="$tab" read -r note_path field value; do
        [ -n "$note_path" ] || continue
        # Compute normalized dedup key (using unitSep to avoid TAB conflicts)
        normalized="$(normalize_value "$value" "$WATCH_SEP")"
        dedup_key="${note_path}${unitSep}${normalized}"
        if grep -qxF "$dedup_key" "$LEDGER"; then continue; fi
        if cut -f1 "$PENDING" 2>/dev/null | grep -qxF "$dedup_key"; then continue; fi
        printf '%s\t%s\t%s\n' "$dedup_key" "$field" "$value" >>"$PENDING"
        last_new="$(date +%s)"
      done <<EOF
$refs
EOF
    fi
  else
    now="$(date +%s)"
    if [ "$fail_since" -eq 0 ]; then fail_since="$now"; fi
    if [ "$warned" -eq 0 ] && [ $((now - fail_since)) -ge 300 ]; then
      echo "watch-frontmatter: endpoint unreachable for 5+ minutes ($url)"
      warned=1
    fi
  fi

  if [ -s "$PENDING" ] && [ "$last_new" -gt 0 ]; then
    now="$(date +%s)"
    if [ $((now - last_new)) -ge "$DEBOUNCE_QUIET" ]; then
      while IFS="$tab" read -r dedup_key field value; do
        [ -n "$dedup_key" ] || continue
        # dedup_key is "note_path<unitSep>normalized_value", split it
        note_path="${dedup_key%%${unitSep}*}"
        echo "frontmatter ${field}=${value} on ${note_path}"
        # Append dedup key to ledger
        printf '%s\n' "$dedup_key" >>"$LEDGER"
      done <"$PENDING"
      : >"$PENDING"
      last_new=0
    fi
  fi

  sleep "$POLL_INTERVAL"
done
