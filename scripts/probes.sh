#!/usr/bin/env bash
#
# Acceptance probes 1-6, run end to end against a real server on a real port.
#
# The script starts and restarts the API itself: three of the probes are
# statements about configuration ("provider A down", "both down", "the mailer
# throws"), so proving them means restarting with that environment. No probe
# depends on a third party actually being down.
#
#   Prerequisites:  docker compose up -d db   &&   .env present
#   Usage:          ./scripts/probes.sh       (writes .evidence/probes.log too)

set -euo pipefail

PORT="${PROBE_PORT:-3011}"
BASE="http://localhost:${PORT}"
ORIGIN="http://localhost:5500"      # the "customer website" — a different origin
VISITOR_IP="8.8.8.8"                # genuinely public, so geo enrichment is not skipped
                                    # (Python treats the RFC 5737 TEST-NET ranges as private)
PASSWORD="probe-password-123456"
EMAIL="probe-$(date +%s)-$$@example.test"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
[ -x "$PYTHON" ] || { echo "No interpreter at $PYTHON — create the venv first."; exit 1; }
mkdir -p .evidence
LOG="$ROOT/.evidence/probes.log"
BODY_FILE="$ROOT/.evidence/body.json"
BIG_BODY="$ROOT/.evidence/oversized-body.json"
SUBMISSION_LIMIT="${SUBMISSION_BODY_LIMIT_BYTES:-16384}"
: > "$LOG"

API_PID=""
FAILURES=0

# Any other process pointed at the same database also polls the `jobs` table.
# It would quietly drain probe 5's deliberately-failing email job with *its*
# configuration, and the probe would report a success that never happened.
guard_against_other_workers() {
  local strays
  strays=$(pgrep -f 'uvicorn app\.http\.app:app|app\.worker' 2>/dev/null | tr '\n' ' ' || true)
  if docker compose ps --services --status running 2>/dev/null | grep -qx api; then
    say "The compose 'api' service is running and shares this job queue."
    say "Stop it first:   docker compose stop api"
    exit 1
  fi
  if [ -n "${strays// /}" ]; then
    say "Another API process is already running (pids: $strays) and shares this job queue."
    say "Stop it first, then re-run:   ./scripts/probes.sh"
    exit 1
  fi
}
guard_against_other_workers

# The transcript is pasted into EVIDENCE.md, so tokens are stripped on the way.
redact() { sed -E 's/(Bearer|bearer) [A-Za-z0-9._-]+/\1 <redacted>/g'; }
say()  { printf '%s\n' "$*" | redact | tee -a "$LOG"; }
head_() { say ""; say "==============================================================================";
          say "$*"; say "=============================================================================="; }
run()  { say ""; say "\$ $*"; set +e; eval "$@" 2>&1 | redact | tee -a "$LOG"; set -e; }

pass() { say "  PASS  $*"; }
fail() { say "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1 -> $2"; else fail "$1 -> expected $3, got $2"; fi; }

# --- server lifecycle ------------------------------------------------------
# Killing the launcher is not enough: `npx tsx` runs the server in a child that
# outlives its parent, and a survivor would keep draining the job queue with the
# previous configuration. So the port is polled until nothing holds it.
stop_api() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  for _ in $(seq 1 40); do
    local holders
    holders=$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
    [ -z "$holders" ] && break
    echo "$holders" | xargs kill 2>/dev/null || true
    sleep 0.25
  done
  API_PID=""
  return 0
}
trap 'stop_api; rm -f "$BODY_FILE" "$BIG_BODY"' EXIT

# start_api "VAR=value VAR2=value" — boots the API with the given overrides.
start_api() {
  stop_api
  local overrides="$1"
  say ""
  say "--- starting API on :$PORT with  ${overrides:-(defaults)}"
  # shellcheck disable=SC2086
  env ENVIRONMENT=development PORT="$PORT" PUBLIC_BASE_URL="$BASE" LOG_LEVEL=info \
      TRUST_PROXY_HOPS=1 ADMIN_CORS_ORIGINS="$BASE,$ORIGIN" \
      GEO_PROVIDERS=mock-a,mock-b RUN_WORKER_IN_PROCESS=true $overrides \
      "$PYTHON" -m uvicorn app.http.app:app --host 127.0.0.1 --port "$PORT" \
      --log-level warning >> "$LOG" 2>&1 &
  API_PID=$!

  for _ in $(seq 1 40); do
    if curl -sf "$BASE/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "API did not become healthy on :$PORT"
  exit 1
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json()   { curl -s "$@"; }
jqp()    { "$PYTHON" -c '
import json, sys
data = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    data = data[int(part)] if part.isdigit() else data.get(part)
    if data is None:
        break
print(data if data is not None else "")' "$1"; }

# ===========================================================================
head_ "SETUP — a tenant, a widget, and the embed snippet"
start_api ""

TOKEN=$(json -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"Probe Co\",\"password\":\"$PASSWORD\"}" | jqp token)
[ -n "$TOKEN" ] || { fail "could not register a probe tenant"; exit 1; }

WIDGET_JSON=$(json -X POST "$BASE/api/widgets" -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" -d '{
    "name": "Probe signup",
    "type": "signup_form",
    "title": "Join the list",
    "notifyEmail": "owner@example.test",
    "fields": [
      { "name": "email", "label": "Email", "type": "email", "required": true },
      { "name": "consent", "label": "I agree", "type": "checkbox", "required": true }
    ]}')
WIDGET_ID=$(printf '%s' "$WIDGET_JSON" | jqp 'widget.id')
PUBLIC_ID=$(printf '%s' "$WIDGET_JSON" | jqp 'widget.publicId')
SNIPPET=$(printf '%s' "$WIDGET_JSON" | jqp 'widget.embed.snippet')

say "  widget id  : $WIDGET_ID"
say "  public id  : $PUBLIC_ID"
say "  snippet    : $SNIPPET"

# A second tenant, so isolation can be proved rather than asserted.
TOKEN_B=$(json -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"other-$EMAIL\",\"name\":\"Other Co\",\"password\":\"$PASSWORD\"}" | jqp token)

# `-H 'Expect:'` suppresses curl's 100-continue handshake for bodies over 1 KB.
# Browsers never send it, and with it curl reports a status that does not match
# what the server logged for an oversized body.
submit() {  # submit <idempotency-key|-> <json-data> [extra curl args...]
  local key="$1"; shift
  local data="$1"; shift
  printf '{"widgetId":"%s","data":%s}' "$PUBLIC_ID" "$data" > "$BODY_FILE"
  local args=(-s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/public/submissions"
              -H 'content-type: application/json' -H 'Expect:' -H "origin: $ORIGIN"
              -H "x-forwarded-for: $VISITOR_IP"
              --data-binary "@$BODY_FILE")
  [ "$key" != "-" ] && args+=(-H "idempotency-key: $key")
  curl "${args[@]}" "$@"
}

# Posts from a file. A 20 KB string nested through command substitution gets
# silently truncated by the shell, and a truncated body proves nothing.
submit_file() {  # submit_file <path> [extra curl args...]
  local file="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/public/submissions" \
    -H 'content-type: application/json' -H 'Expect:' -H "origin: $ORIGIN" \
    -H "x-forwarded-for: $VISITOR_IP" --data-binary "@$file" "$@"
}

# ===========================================================================
head_ "PROBE 1 — a valid cross-origin submission is stored and visible on the dashboard"
run "curl -si -X POST '$BASE/api/public/submissions' \
  -H 'content-type: application/json' -H 'origin: $ORIGIN' -H 'x-forwarded-for: $VISITOR_IP' \
  -d '{\"widgetId\":\"$PUBLIC_ID\",\"data\":{\"email\":\"visitor@example.com\",\"consent\":true},\"pageUrl\":\"$ORIGIN/pricing\"}' \
  | sed -n '1p;/^access-control-allow-origin/Ip;/^cache-control/Ip;\$p'"

CODE=$(submit - '{"email":"probe1@example.com","consent":true}')
check "valid submission accepted" "$CODE" "202"

run "curl -s '$BASE/api/dashboard/submissions?limit=2' -H 'authorization: Bearer $TOKEN'"
STORED=$(json "$BASE/api/dashboard/submissions" -H "authorization: Bearer $TOKEN" | jqp 'pagination.total')
[ "$STORED" -ge 2 ] && pass "dashboard lists the stored submissions (total=$STORED)" \
                    || fail "dashboard did not list the submissions (total=$STORED)"

say ""
say "--- multi-tenant isolation: tenant B must not see tenant A's data"
check "tenant B reading tenant A's widget" "$(status "$BASE/api/widgets/$WIDGET_ID" -H "authorization: Bearer $TOKEN_B")" "404"
check "unauthenticated widget list"        "$(status "$BASE/api/widgets")" "401"
B_TOTAL=$(json "$BASE/api/dashboard/submissions" -H "authorization: Bearer $TOKEN_B" | jqp 'pagination.total')
check "tenant B's submission count"        "$B_TOTAL" "0"

say ""
say "--- widget delivery: preflight, cache headers and the versioned bundle"
run "curl -si -X OPTIONS '$BASE/api/public/submissions' -H 'origin: $ORIGIN' \
  -H 'access-control-request-method: POST' -H 'access-control-request-headers: content-type,idempotency-key' \
  | sed -n '1p;/^access-control/Ip'"
run "curl -si '$BASE/api/public/widgets/$PUBLIC_ID/config' -H 'origin: $ORIGIN' \
  | sed -n '1p;/^cache-control/Ip;/^etag/Ip;/^vary/Ip;\$p'"
ETAG=$(curl -sI "$BASE/api/public/widgets/$PUBLIC_ID/config" | awk 'BEGIN{IGNORECASE=1}/^etag/{print $2}' | tr -d '\r')
check "conditional config request" "$(status "$BASE/api/public/widgets/$PUBLIC_ID/config" -H "if-none-match: $ETAG")" "304"
VERSION=$(json "$BASE/api/public/version" | jqp widgetVersion)
run "curl -sI '$BASE/embed/$VERSION/widget.js' | sed -n '1p;/^content-type/Ip;/^cache-control/Ip;/^x-widget-version/Ip'"

# ===========================================================================
head_ "PROBE 2 — malformed and oversized payloads get clean 4xx JSON, never a 500"
run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' -d '{\"widgetId\":' | sed -n '1p;\$p'"
run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' \
  -d '{\"widgetId\":\"$PUBLIC_ID\",\"data\":{\"email\":\"not-an-email\",\"consent\":false}}' | sed -n '1p;\$p'"
{ printf '{"widgetId":"%s","data":{"email":"a@b.com","consent":true,"note":"' "$PUBLIC_ID"
  head -c 20000 < /dev/zero | tr '\0' 'x'
  printf '"}}'
} > "$BIG_BODY"
say ""
say "a $(wc -c < "$BIG_BODY" | tr -d ' ')-byte body, against a $SUBMISSION_LIMIT-byte limit:"
run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' -H 'Expect:' \
  --data-binary @'$BIG_BODY' | sed -n '1p;\$p'"

check "malformed JSON"     "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/public/submissions" -H 'content-type: application/json' -d '{"widgetId":')" "400"
check "invalid field data" "$(submit - '{"email":"not-an-email","consent":false}')" "422"
check "undeclared field"   "$(submit - '{"email":"a@b.com","consent":true,"is_admin":"yes"}')" "422"
check "oversized payload"  "$(submit_file "$BIG_BODY")" "413"
check "unknown widget id"  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/public/submissions" -H 'content-type: application/json' -d '{"widgetId":"doesnotexist99","data":{}}')" "404"

say ""
say "--- idempotency: the same key twice must not create two leads"
check "first request"  "$(submit probe-idem-key '{"email":"idem@example.com","consent":true}')" "202"
check "retried request" "$(submit probe-idem-key '{"email":"idem@example.com","consent":true}')" "200"

# ===========================================================================
head_ "PROBE 3 — a burst gets 429s, and the API keeps serving legitimate traffic"
start_api "RATE_LIMIT_IP_MAX=5 RATE_LIMIT_IP_WINDOW_SECONDS=60"

say ""
say "12 rapid submissions from one IP:"
BURST=""
for i in $(seq 1 12); do
  BURST="$BURST $(submit - "{\"email\":\"burst$i@example.com\",\"consent\":true}")"
done
say "  $BURST"
LIMITED=$(printf '%s' "$BURST" | tr ' ' '\n' | grep -c '^429$' || true)
[ "$LIMITED" -gt 0 ] && pass "$LIMITED of 12 requests were rejected with 429" || fail "no 429 under a burst"

run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' \
  -H 'x-forwarded-for: $VISITOR_IP' -d '{\"widgetId\":\"$PUBLIC_ID\",\"data\":{\"email\":\"x@y.com\",\"consent\":true}}' \
  | sed -n '1p;/^retry-after/Ip;/^ratelimit/Ip;\$p'"

say ""
say "--- and the service is still up for everyone else"
check "health"                 "$(status "$BASE/healthz")" "200"
check "widget config"          "$(status "$BASE/api/public/widgets/$PUBLIC_ID/config")" "200"
check "dashboard"              "$(status "$BASE/api/dashboard/stats" -H "authorization: Bearer $TOKEN")" "200"
check "another visitor's IP"   "$(submit - '{"email":"innocent@example.com","consent":true}' -H 'x-forwarded-for: 203.0.113.99')" "202"

# ===========================================================================
head_ "PROBE 4 — geo enrichment falls back, and degrades without failing"
geo_of() {  # geo_of -> "<provider> <status> <country>" for the newest submission
  json "$BASE/api/dashboard/submissions?limit=1" -H "authorization: Bearer $TOKEN" \
    | "$PYTHON" -c '
import json, sys
s = json.load(sys.stdin)["submissions"][0]
print(s["geoProvider"], s["geoStatus"], s["country"])' 
}

start_api ""
submit - '{"email":"geo-a@example.com","consent":true}' > /dev/null
say ""; say "provider A up  ->  $(geo_of)"
[ "$(geo_of | cut -d' ' -f1)" = "mock-a" ] && pass "provider A enriched the submission" || fail "provider A did not enrich"

start_api "GEO_FORCE_DOWN=mock-a"
submit - '{"email":"geo-b@example.com","consent":true}' > /dev/null
say ""; say "provider A DOWN ->  $(geo_of)"
RESULT=$(geo_of)
[ "$(printf '%s' "$RESULT" | cut -d' ' -f1)" = "mock-b" ] && pass "fell back to provider B" || fail "did not fall back to provider B"
[ "$(printf '%s' "$RESULT" | cut -d' ' -f2)" = "enriched" ] && pass "submission still enriched" || fail "submission not enriched"

start_api "GEO_FORCE_DOWN=mock-a,mock-b"
CODE=$(submit - '{"email":"geo-none@example.com","consent":true}')
say ""; say "both providers DOWN ->  $(geo_of)"
check "submission still accepted with no geo provider" "$CODE" "202"
[ "$(geo_of | cut -d' ' -f2)" = "unavailable" ] && pass "stored without geo — degraded, not failed" || fail "geo status is wrong"

# ===========================================================================
head_ "PROBE 5 — a failing side effect does not stop the submission being stored"
start_api "EMAIL_TRANSPORT=fail"
say ""
say "EMAIL_TRANSPORT=fail makes every confirmation email throw."
run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' \
  -H 'x-forwarded-for: $VISITOR_IP' \
  -d '{\"widgetId\":\"$PUBLIC_ID\",\"data\":{\"email\":\"sideeffect@example.com\",\"consent\":true}}' | sed -n '1p;\$p'"

BEFORE=$(json "$BASE/api/dashboard/submissions" -H "authorization: Bearer $TOKEN" | jqp 'pagination.total')
CODE=$(submit - '{"email":"sideeffect2@example.com","consent":true}')
check "submission accepted despite the broken mailer" "$CODE" "202"
sleep 3   # let the worker attempt (and fail) the job
AFTER=$(json "$BASE/api/dashboard/submissions" -H "authorization: Bearer $TOKEN" | jqp 'pagination.total')
[ "$AFTER" -gt "$BEFORE" ] && pass "the row is stored ($BEFORE -> $AFTER)" || fail "the submission was not stored"

say ""
say "--- the failure is visible in the job queue, not in the visitor's response"
run "curl -s '$BASE/readyz' "
# The worker retries on a backoff, so poll rather than sleep-and-hope.
RETRY_LINE=""
for _ in $(seq 1 20); do
  RETRY_LINE=$(grep -E 'job failed, scheduled for retry' "$LOG" | tail -1 || true)
  [ -n "$RETRY_LINE" ] && break
  sleep 1
done
if [ -n "$RETRY_LINE" ]; then
  say "$RETRY_LINE"
  pass "the failing email job was retried in the background, not on the request path"
else
  fail "no background retry was recorded"
fi

# ===========================================================================
head_ "PROBE 6 — a filled honeypot is dropped silently"
start_api ""
run "curl -si -X POST '$BASE/api/public/submissions' -H 'content-type: application/json' \
  -H 'x-forwarded-for: $VISITOR_IP' \
  -d '{\"widgetId\":\"$PUBLIC_ID\",\"data\":{\"email\":\"bot@spam.test\",\"consent\":true,\"company_website\":\"http://spam.example\"}}' \
  | sed -n '1p;\$p'"

CODE=$(submit - '{"email":"bot2@spam.test","consent":true,"company_website":"http://spam.example"}')
check "the bot gets the same 202 a human gets" "$CODE" "202"

run "curl -s '$BASE/api/dashboard/submissions?status=spam&limit=3' -H 'authorization: Bearer $TOKEN'"
SPAM=$(json "$BASE/api/dashboard/submissions?status=spam" -H "authorization: Bearer $TOKEN" | jqp 'pagination.total')
[ "$SPAM" -ge 2 ] && pass "$SPAM submissions classified as spam, none in the real inbox" || fail "honeypot did not catch the bot"

STORED_BOT=$(json "$BASE/api/dashboard/submissions?status=stored" -H "authorization: Bearer $TOKEN" \
  | grep -c 'bot@spam.test' || true)
check "the spam never appears among real leads" "$STORED_BOT" "0"

# ===========================================================================
head_ "RESULT"
if [ "$FAILURES" -eq 0 ]; then
  say "All probes passed. Full transcript: .evidence/probes.log"
else
  say "$FAILURES check(s) FAILED. Full transcript: .evidence/probes.log"
  exit 1
fi
