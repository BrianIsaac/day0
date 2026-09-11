#!/usr/bin/env bash
# Arrival connectivity probe for running Day0 on a hosted OpenAI-compatible
# model endpoint from a network you do not control (a hotel, a venue, a
# roaming SIM). Written for the GOAI final in mainland China with GLM 5.3 Flash
# on Featherless as the model route, but nothing in it is specific to that
# pair: pass --base-url and --model for any OpenAI-compatible server.
#
# It answers, in order, the questions a live demo depends on:
#
#   1. DNS      does the hostname resolve here, and to what
#   2. TLS      does a TLS handshake complete, with which certificate
#   3. HTTPS    does the API answer at all (GET /models/<id>, GET /models)
#   4. auth     with a key: a plain completion, a tool call, response_format
#               json_object (Day0's raw rung) and json_schema (Mastra's rung)
#   5. refs     are the other hosts a live Day0 run dials reachable
#
# Reachability is a network fact and nothing more. A host that answers from
# here is not thereby a host whose terms permit use from here; that question
# is answered by the provider's supported-region policy, not by this script.
#
# The key is read from FEATHERLESS_API_KEY (or the variable named by
# --key-var), or from KEY=value lines in --env-file. It is never printed and
# never placed on a command line. With no key the authenticated steps are
# reported as pending rather than failed.
#
# Observed on 12 Sep 2026 against Featherless with GLM 5.3 Flash: curl and the
# official SDKs pass Cloudflare, but a generic Python-urllib User-Agent is
# refused with "error code: 1010" before reaching the API; response_format
# json_object is accepted and answered with empty content while the reasoning
# runs; json_schema is answered "This model is busy" every time, sometimes
# inside an HTTP 200. Day0 runs on its prompt-injection rung there, so the
# two JSON steps below are advisory rather than required.
#
# Usage:
#   scripts/probe-china-connectivity.sh                      # Featherless defaults
#   scripts/probe-china-connectivity.sh --env-file .env.local
#   scripts/probe-china-connectivity.sh --base-url https://api.z.ai/api/paas/v4 \
#       --model glm-5.3-flash --key-var ZAI_API_KEY --no-catalogue
#   scripts/probe-china-connectivity.sh --dry-run            # print the plan, no network
#
# Exit status: 0 when every step that ran passed (pending steps do not fail),
# 2 when a required step failed, 64 on a usage error.

set -euo pipefail

BASE_URL="https://api.featherless.ai/v1"
MODEL="zai-org/GLM-5.3-Flash"
KEY_VAR="FEATHERLESS_API_KEY"
ENV_FILE=""
TIMEOUT=30
COMPLETION_TIMEOUT=120
CATALOGUE=1
REFERENCE=1
DRY_RUN=0
THINKING="default"
REASONING_EFFORT=""
EXTRA_BODY=""

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --base-url URL        OpenAI-compatible base URL (default ${BASE_URL})
  --model ID            exact model id the server lists (default ${MODEL})
  --key-var NAME        environment variable holding the key (default ${KEY_VAR})
  --env-file PATH       read NAME=value lines from PATH; the value is never printed
  --timeout SECONDS     per-request ceiling for the network steps (default ${TIMEOUT})
  --completion-timeout SECONDS
                        ceiling for each authenticated completion (default ${COMPLETION_TIMEOUT})
  --thinking on|off     send {"chat_template_kwargs":{"enable_thinking":true|false}}
                        with each completion, the Featherless reasoning switch;
                        default sends nothing, which is what Day0 sends. Z.ai's own
                        endpoints use {"thinking":{"type":"enabled"}} instead; pass
                        that through --extra-body
  --reasoning-effort low|high|max
                        send reasoning_effort, the depth knob GLM 5.3 documents;
                        default sends nothing
  --extra-body JSON     object merged into every completion body (needs python3)
  --no-catalogue        skip the full GET /models listing (several megabytes)
  --no-reference        skip the reference-host reachability section
  --dry-run             print the plan and the key status, make no request
  -h, --help            this text
EOF
}

die_usage() {
  echo "error: $*" >&2
  echo "run with --help for usage" >&2
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) [ $# -ge 2 ] || die_usage "$1 needs a value"; BASE_URL="$2"; shift 2 ;;
    --model) [ $# -ge 2 ] || die_usage "$1 needs a value"; MODEL="$2"; shift 2 ;;
    --key-var) [ $# -ge 2 ] || die_usage "$1 needs a value"; KEY_VAR="$2"; shift 2 ;;
    --env-file) [ $# -ge 2 ] || die_usage "$1 needs a value"; ENV_FILE="$2"; shift 2 ;;
    --timeout) [ $# -ge 2 ] || die_usage "$1 needs a value"; TIMEOUT="$2"; shift 2 ;;
    --completion-timeout) [ $# -ge 2 ] || die_usage "$1 needs a value"; COMPLETION_TIMEOUT="$2"; shift 2 ;;
    --thinking) [ $# -ge 2 ] || die_usage "$1 needs a value"; THINKING="$2"; shift 2 ;;
    --reasoning-effort) [ $# -ge 2 ] || die_usage "$1 needs a value"; REASONING_EFFORT="$2"; shift 2 ;;
    --extra-body) [ $# -ge 2 ] || die_usage "$1 needs a value"; EXTRA_BODY="$2"; shift 2 ;;
    --no-catalogue) CATALOGUE=0; shift ;;
    --no-reference) REFERENCE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die_usage "unknown option $1" ;;
  esac
done

case "$THINKING" in
  default|on|off) ;;
  *) die_usage "--thinking must be on, off or default" ;;
esac
case "$REASONING_EFFORT" in
  ""|low|high|max) ;;
  *) die_usage "--reasoning-effort must be low, high or max" ;;
esac
case "$TIMEOUT$COMPLETION_TIMEOUT" in
  *[!0-9]*) die_usage "timeouts must be whole seconds" ;;
esac

BASE_URL="${BASE_URL%/}"
HOST="$(printf '%s' "$BASE_URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')"
[ -n "$HOST" ] || die_usage "could not read a hostname from ${BASE_URL}"

command -v curl >/dev/null 2>&1 || die_usage "curl is required"
HAVE_PYTHON=0
if command -v python3 >/dev/null 2>&1; then HAVE_PYTHON=1; fi
if [ -n "$EXTRA_BODY" ] && [ "$HAVE_PYTHON" -eq 0 ]; then
  die_usage "--extra-body needs python3 to merge the object"
fi

# ---------------------------------------------------------------------------
# Key handling. The value only ever lives in $API_KEY and is passed to curl
# through a config file on stdin, so it appears in no argument list and no
# process listing.
# ---------------------------------------------------------------------------
API_KEY="${!KEY_VAR:-}"
KEY_SOURCE=""
if [ -n "$API_KEY" ]; then
  KEY_SOURCE="environment (${KEY_VAR})"
elif [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die_usage "--env-file ${ENV_FILE} does not exist"
  # First matching line wins; a quoted value has its quotes removed.
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${KEY_VAR}=" "$ENV_FILE" | head -n 1 || true)"
  if [ -n "$line" ]; then
    API_KEY="${line#*=}"
    API_KEY="$(printf '%s' "$API_KEY" | sed -E "s/^[[:space:]]*//; s/[[:space:]]*$//; s/^\"(.*)\"$/\\1/; s/^'(.*)'$/\\1/")"
    [ -n "$API_KEY" ] && KEY_SOURCE="${ENV_FILE} (${KEY_VAR})"
  fi
elif [ -f .env.local ]; then
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${KEY_VAR}=" .env.local | head -n 1 || true)"
  if [ -n "$line" ]; then
    API_KEY="${line#*=}"
    API_KEY="$(printf '%s' "$API_KEY" | sed -E "s/^[[:space:]]*//; s/[[:space:]]*$//; s/^\"(.*)\"$/\\1/; s/^'(.*)'$/\\1/")"
    [ -n "$API_KEY" ] && KEY_SOURCE=".env.local (${KEY_VAR})"
  fi
fi
if [ -n "$API_KEY" ]; then
  KEY_STATUS="present, from ${KEY_SOURCE}, $(printf '%s' "$API_KEY" | wc -c | tr -d ' ') characters"
else
  KEY_STATUS="absent (set ${KEY_VAR} or pass --env-file); authenticated steps are pending"
fi

# curl reads the Authorization header from a config file on stdin.
auth_config() {
  printf 'header = "Authorization: Bearer %s"\n' "$API_KEY"
}

# ---------------------------------------------------------------------------
# Result bookkeeping. Plain arrays keep this runnable on the bash 3.2 that
# macOS ships.
# ---------------------------------------------------------------------------
RESULT_NAMES=()
RESULT_TAGS=()
RESULT_DETAILS=()
FAILED=0
AUTH_REJECTED=0

record() {
  # record TAG NAME DETAIL; TAG is pass, FAIL, note, skip or info.
  RESULT_TAGS+=("$1")
  RESULT_NAMES+=("$2")
  RESULT_DETAILS+=("$3")
  printf '%-5s %-34s %s\n' "$1" "$2" "$3"
  if [ "$1" = "FAIL" ]; then FAILED=1; fi
}

section() {
  printf '\n== %s\n' "$1"
}

trim() {
  # Shorten a body for display: one line, at most N characters.
  local limit="$1"
  tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-"$limit"
}

now_ms() {
  if [ "$HAVE_PYTHON" -eq 1 ]; then
    python3 -c 'import time; print(int(time.time()*1000))'
  else
    date +%s000
  fi
}

TMPDIR_PROBE="$(mktemp -d "${TMPDIR:-/tmp}/day0-probe.XXXXXX")"
trap 'rm -rf "$TMPDIR_PROBE"' EXIT

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
echo "Day0 arrival connectivity probe"
echo "  when        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  base URL    ${BASE_URL}"
echo "  host        ${HOST}"
echo "  model       ${MODEL}"
echo "  key         ${KEY_STATUS}"
echo "  thinking    ${THINKING}"
echo "  effort      ${REASONING_EFFORT:-default}"
echo "  catalogue   $([ "$CATALOGUE" -eq 1 ] && echo 'GET /models (full listing)' || echo 'skipped')"
echo "  references  $([ "$REFERENCE" -eq 1 ] && echo 'yes' || echo 'skipped')"
echo "  python3     $([ "$HAVE_PYTHON" -eq 1 ] && echo 'available, responses parsed' || echo 'absent, responses grepped')"
if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "dry run: no request made"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. DNS
# ---------------------------------------------------------------------------
section "1. DNS for ${HOST}"
resolve_system() {
  if command -v getent >/dev/null 2>&1; then
    getent ahosts "$HOST" | awk '{print $1}' | sort -u
  elif command -v dig >/dev/null 2>&1; then
    dig +short "$HOST" A "$HOST" AAAA | grep -E '^[0-9a-f.:]+$' | sort -u
  elif command -v host >/dev/null 2>&1; then
    host "$HOST" | awk '/has (IPv6 )?address/ {print $NF}' | sort -u
  elif [ "$HAVE_PYTHON" -eq 1 ]; then
    python3 - "$HOST" <<'EOF'
import socket, sys
seen = set()
for row in socket.getaddrinfo(sys.argv[1], 443, proto=socket.IPPROTO_TCP):
    seen.add(row[4][0])
print("\n".join(sorted(seen)))
EOF
  fi
}
SYSTEM_ADDRS=""
dns_attempts=0
while [ -z "$SYSTEM_ADDRS" ] && [ "$dns_attempts" -lt 3 ]; do
  dns_attempts=$((dns_attempts + 1))
  SYSTEM_ADDRS="$(resolve_system 2>/dev/null || true)"
  [ -z "$SYSTEM_ADDRS" ] && sleep 1
done
if [ -n "$SYSTEM_ADDRS" ]; then
  attempts_note=""
  [ "$dns_attempts" -gt 1 ] && attempts_note=" (after ${dns_attempts} attempts)"
  record pass "dns: system resolver" "$(printf '%s' "$SYSTEM_ADDRS" | tr '\n' ' ')${attempts_note}"
else
  record FAIL "dns: system resolver" "no address for ${HOST}; nothing below can work on this network"
fi

# A second opinion over DNS-over-HTTPS. On a network that rewrites answers the
# two sets differ; on one that blocks the resolver this step fails while the
# system answer still stands, which is itself worth knowing. Advisory only.
DOH_ADDRS="$(curl -sS --max-time 8 -H 'accept: application/dns-json' \
  "https://dns.google/resolve?name=${HOST}&type=A" 2>/dev/null \
  | tr ',' '\n' | sed -nE 's/.*"data":"([0-9.]+)".*/\1/p' | sort -u || true)"
if [ -n "$DOH_ADDRS" ]; then
  if [ -n "$SYSTEM_ADDRS" ] && printf '%s\n' "$SYSTEM_ADDRS" | grep -qxF "$(printf '%s\n' "$DOH_ADDRS" | head -n 1)"; then
    record pass "dns: dns.google cross-check" "agrees with the system resolver"
  else
    record note "dns: dns.google cross-check" "differs: $(printf '%s' "$DOH_ADDRS" | tr '\n' ' ')(a CDN can legitimately answer differently per resolver)"
  fi
else
  record note "dns: dns.google cross-check" "no answer from dns.google within 8 s (blocked or slow here); system answer stands"
fi

# ---------------------------------------------------------------------------
# 2. TCP and TLS
# ---------------------------------------------------------------------------
section "2. TCP and TLS to ${HOST}:443"
TLS_OUT="$TMPDIR_PROBE/tls.txt"
: > "$TMPDIR_PROBE/tls.err"
if curl -sS -o /dev/null --max-time "$TIMEOUT" \
  -w 'connect=%{time_connect} tls=%{time_appconnect} ip=%{remote_ip} http=%{http_code} verify=%{ssl_verify_result}\n' \
  "${BASE_URL}/models/${MODEL}" > "$TLS_OUT" 2>"$TMPDIR_PROBE/tls.err"; then
  record pass "tcp+tls handshake" "$(cat "$TLS_OUT")"
else
  record FAIL "tcp+tls handshake" "curl: $(trim 200 < "$TMPDIR_PROBE/tls.err")"
fi
if command -v openssl >/dev/null 2>&1; then
  CERT="$(printf '' | openssl s_client -servername "$HOST" -connect "${HOST}:443" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -enddate 2>/dev/null | tr '\n' ' ' || true)"
  if [ -n "$CERT" ]; then
    # A certificate issued by anything other than the expected public CA chain
    # (an interception proxy, a captive portal) shows here as an unexpected issuer.
    record info "tls certificate" "$(printf '%s' "$CERT" | sed -E 's/subject=//; s/issuer=/ issuer=/; s/notAfter=/ expires=/' | trim 200)"
  else
    record note "tls certificate" "openssl could not read a certificate (handshake blocked or reset)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. HTTPS: the model record and the catalogue
# ---------------------------------------------------------------------------
section "3. HTTPS API surface"
MODEL_OUT="$TMPDIR_PROBE/model.json"
: > "$MODEL_OUT"
MODEL_CODE="$(curl -sS -o "$MODEL_OUT" --max-time "$TIMEOUT" -w '%{http_code}' \
  "${BASE_URL}/models/${MODEL}" 2>"$TMPDIR_PROBE/model.err" || true)"
MODEL_CODE="${MODEL_CODE:-000}"
if [ "$MODEL_CODE" = "200" ] && grep -q "\"id\":[[:space:]]*\"${MODEL}\"" "$MODEL_OUT"; then
  detail="listed"
  if grep -q '"status":"active"' "$MODEL_OUT"; then detail="${detail}, status active"; fi
  ctx="$(sed -nE 's/.*"context_length":([0-9]+).*/\1/p' "$MODEL_OUT" | head -n 1)"
  [ -n "$ctx" ] && detail="${detail}, context ${ctx}"
  tier="$(sed -nE 's/.*"tier":"([a-z]+)".*/\1/p' "$MODEL_OUT" | head -n 1)"
  [ -n "$tier" ] && detail="${detail}, availability ${tier}"
  if grep -q '"tool_use":true' "$MODEL_OUT"; then detail="${detail}, tool_use advertised"; fi
  record pass "GET /models/<model>" "$detail"
elif [ "$MODEL_CODE" = "200" ]; then
  record note "GET /models/<model>" "200 but the body does not name ${MODEL}: $(trim 160 < "$MODEL_OUT")"
elif [ "$MODEL_CODE" = "401" ] || [ "$MODEL_CODE" = "404" ]; then
  record note "GET /models/<model>" "HTTP ${MODEL_CODE}; this server does not expose a public per-model record (the listing below decides)"
elif [ "$MODEL_CODE" = "000" ]; then
  record FAIL "GET /models/<model>" "no HTTP response: $(trim 200 < "$TMPDIR_PROBE/model.err")"
else
  record FAIL "GET /models/<model>" "HTTP ${MODEL_CODE}: $(trim 160 < "$MODEL_OUT")"
fi

if [ "$CATALOGUE" -eq 1 ]; then
  LIST_OUT="$TMPDIR_PROBE/models.json"
  : > "$LIST_OUT"
  started="$(now_ms)"
  LIST_CODE="$(curl -sS -o "$LIST_OUT" --max-time "$((TIMEOUT * 4))" -w '%{http_code}' \
    -K <(if [ -n "$API_KEY" ]; then auth_config; fi) \
    "${BASE_URL}/models" 2>"$TMPDIR_PROBE/models.err" || true)"
  LIST_CODE="${LIST_CODE:-000}"
  elapsed=$(( $(now_ms) - started ))
  if [ "$LIST_CODE" = "200" ]; then
    count="$(grep -o '"id":' "$LIST_OUT" | wc -l | tr -d ' ')"
    size="$(wc -c < "$LIST_OUT" | tr -d ' ')"
    if grep -q "\"id\":[[:space:]]*\"${MODEL}\"" "$LIST_OUT"; then
      record pass "GET /models" "${count} ids, ${size} bytes in ${elapsed} ms; ${MODEL} present"
    else
      record FAIL "GET /models" "${count} ids in ${elapsed} ms but ${MODEL} is not among them; check the exact id"
    fi
  elif [ "$LIST_CODE" = "401" ] && [ -z "$API_KEY" ]; then
    record skip "GET /models" "HTTP 401 without a key; pending key"
  elif [ "$LIST_CODE" = "000" ]; then
    record FAIL "GET /models" "no HTTP response after ${elapsed} ms: $(trim 200 < "$TMPDIR_PROBE/models.err")"
  else
    record FAIL "GET /models" "HTTP ${LIST_CODE}: $(trim 160 < "$LIST_OUT")"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Authenticated inference, in the shapes Day0 sends
# ---------------------------------------------------------------------------
section "4. Authenticated inference as ${MODEL}"

# Build a chat-completions body. Day0 sends max_completion_tokens, a system
# and a user message, and (on its native rung) response_format. The ceiling
# here is the 4000 Day0's raw path uses; on a thinking model the reasoning
# tokens count against it, which is what the reasoning fields in the report
# make visible. The thinking switch, reasoning effort and --extra-body are
# merged in when asked for.
build_body() {
  # build_body USER_TEXT EXTRA_JSON_FIELDS
  local user="$1"
  local extra="$2"
  local thinking=""
  case "$THINKING" in
    on) thinking=',"chat_template_kwargs":{"enable_thinking":true}' ;;
    off) thinking=',"chat_template_kwargs":{"enable_thinking":false}' ;;
  esac
  if [ -n "$REASONING_EFFORT" ]; then
    thinking="${thinking},\"reasoning_effort\":\"${REASONING_EFFORT}\""
  fi
  local body
  body="{\"model\":\"${MODEL}\",\"temperature\":0.4,\"max_completion_tokens\":4000,\"messages\":[{\"role\":\"system\",\"content\":\"You are terse. Follow the instruction exactly.\"},{\"role\":\"user\",\"content\":\"${user}\"}]${extra}${thinking}}"
  if [ -n "$EXTRA_BODY" ]; then
    body="$(python3 - "$body" "$EXTRA_BODY" <<'EOF'
import json, sys
base = json.loads(sys.argv[1])
base.update(json.loads(sys.argv[2]))
print(json.dumps(base))
EOF
)"
  fi
  printf '%s' "$body"
}

# post_chat NAME BODY -> writes $TMPDIR_PROBE/NAME.json and NAME.code, prints elapsed ms
post_chat() {
  local name="$1"
  local body="$2"
  local started code
  : > "$TMPDIR_PROBE/${name}.json"
  started="$(now_ms)"
  code="$(curl -sS -o "$TMPDIR_PROBE/${name}.json" --max-time "$COMPLETION_TIMEOUT" -w '%{http_code}' \
    -K <(auth_config) \
    -H 'content-type: application/json' \
    --data-binary "$body" \
    "${BASE_URL}/chat/completions" 2>"$TMPDIR_PROBE/${name}.err" || true)"
  printf '%s' "${code:-000}" > "$TMPDIR_PROBE/${name}.code"
  echo $(( $(now_ms) - started ))
}

# Retry once with max_tokens when a server rejects the newer field name.
post_chat_with_fallback() {
  local name="$1"
  local body="$2"
  local elapsed code
  elapsed="$(post_chat "$name" "$body")"
  code="$(cat "$TMPDIR_PROBE/${name}.code")"
  if [ "$code" = "400" ] && grep -qi 'max_completion_tokens' "$TMPDIR_PROBE/${name}.json"; then
    MAX_TOKENS_NOTE="server rejected max_completion_tokens; retried with max_tokens (Day0 sends the former)"
    body="$(printf '%s' "$body" | sed 's/"max_completion_tokens"/"max_tokens"/')"
    elapsed="$(post_chat "$name" "$body")"
  fi
  echo "$elapsed"
}
MAX_TOKENS_NOTE=""

# Inspect a completion with python3 when present, otherwise with grep.
# Prints: STATUS|DETAIL where STATUS is ok, empty, error.
inspect_completion() {
  local file="$1"
  local expect="$2"   # text | tool | json
  if [ "$HAVE_PYTHON" -eq 1 ]; then
    python3 - "$file" "$expect" <<'EOF'
import json, sys
path, expect = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(path))
except Exception as exc:
    print(f"error|body is not JSON ({exc})"); sys.exit(0)
if "error" in doc:
    err = doc["error"]
    msg = err.get("message") if isinstance(err, dict) else err
    print(f"error|{str(msg)[:160]}"); sys.exit(0)
choices = doc.get("choices") or []
if not choices:
    print("error|no choices in response"); sys.exit(0)
msg = choices[0].get("message") or {}
finish = choices[0].get("finish_reason")
usage = doc.get("usage") or {}
details = usage.get("completion_tokens_details") or {}
reasoning_tokens = details.get("reasoning_tokens")
content = msg.get("content") or ""
reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
tool_calls = msg.get("tool_calls") or []
extra = f"finish={finish} prompt={usage.get('prompt_tokens')} completion={usage.get('completion_tokens')}"
if reasoning_tokens is not None:
    extra += f" reasoning_tokens={reasoning_tokens}"
if reasoning:
    extra += f" reasoning_content={len(reasoning)}ch"
if "<think>" in content:
    extra += " content-has-<think>"
if expect == "tool":
    if not tool_calls:
        print(f"empty|no tool_calls; content={content[:80]!r} {extra}"); sys.exit(0)
    call = tool_calls[0].get("function") or {}
    name = call.get("name")
    raw = call.get("arguments")
    try:
        args = json.loads(raw) if isinstance(raw, str) else raw
        ok = isinstance(args, dict) and "city" in args
    except Exception:
        ok = False
    if name == "get_weather" and ok:
        print(f"ok|tool={name} args={json.dumps(args)[:80]} n_calls={len(tool_calls)} {extra}")
    else:
        print(f"empty|tool={name!r} arguments={str(raw)[:80]!r} {extra}")
    sys.exit(0)
if expect == "json":
    text = content.strip()
    try:
        obj = json.loads(text)
        ok = isinstance(obj, dict) and "title" in obj and "priority" in obj
    except Exception:
        ok = False
    if ok:
        print(f"ok|object parsed: {json.dumps(obj)[:80]} {extra}")
    else:
        print(f"empty|content is not a bare JSON object: {text[:100]!r} {extra}")
    sys.exit(0)
if content.strip():
    print(f"ok|content={content.strip()[:60]!r} {extra}")
else:
    print(f"empty|empty content {extra}")
EOF
  else
    if grep -q '"error"' "$file"; then
      printf 'error|%s' "$(trim 160 < "$file")"
    elif [ "$expect" = "tool" ] && grep -q '"tool_calls"' "$file" && grep -q 'get_weather' "$file"; then
      printf 'ok|tool_calls present (install python3 for argument checks)'
    elif [ "$expect" = "tool" ]; then
      printf 'empty|no tool_calls in response'
    elif grep -q '"content":"[^"]' "$file"; then
      printf 'ok|%s' "$(sed -nE 's/.*"content":"([^"]{0,60}).*/\1/p' "$file" | head -n 1)"
    else
      printf 'empty|no content'
    fi
  fi
}

report_completion() {
  # report_completion NAME LABEL EXPECT ELAPSED REQUIRED(1|0)
  local name="$1" label="$2" expect="$3" elapsed="$4" required="$5"
  local code verdict status detail
  code="$(cat "$TMPDIR_PROBE/${name}.code")"
  if [ "$code" = "000" ]; then
    record FAIL "$label" "no HTTP response after ${elapsed} ms: $(trim 160 < "$TMPDIR_PROBE/${name}.err")"
    return
  fi
  if [ "$code" != "200" ]; then
    if [ "$code" = "401" ] || [ "$code" = "403" ]; then AUTH_REJECTED=1; fi
    detail="HTTP ${code} in ${elapsed} ms: $(trim 160 < "$TMPDIR_PROBE/${name}.json")"
    if [ "$required" -eq 1 ]; then record FAIL "$label" "$detail"; else record note "$label" "$detail"; fi
    return
  fi
  verdict="$(inspect_completion "$TMPDIR_PROBE/${name}.json" "$expect")"
  status="${verdict%%|*}"
  detail="${verdict#*|}"
  case "$status" in
    ok) record pass "$label" "${elapsed} ms; ${detail}" ;;
    *) if [ "$required" -eq 1 ]; then record FAIL "$label" "${elapsed} ms; ${detail}"; else record note "$label" "${elapsed} ms; ${detail}"; fi ;;
  esac
}

if [ -z "$API_KEY" ]; then
  record skip "chat completion" "pending key"
  record skip "tool call" "pending key"
  record skip "response_format json_object" "pending key"
  record skip "response_format json_schema" "pending key"
else
  # 4a. Plain completion: the floor. Required.
  body="$(build_body 'Reply with exactly the single word: ready' '')"
  elapsed="$(post_chat_with_fallback plain "$body")"
  report_completion plain "chat completion" text "$elapsed" 1
  [ -n "$MAX_TOKENS_NOTE" ] && record note "max_completion_tokens" "$MAX_TOKENS_NOTE"

  # 4b. Tool call: what the ordinary (baseline) arm and any MCP surface need.
  tools='"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["city"]}}}],"tool_choice":"auto"'
  body="$(build_body 'What is the weather in Hangzhou right now? Use the tool.' ",${tools}")"
  elapsed="$(post_chat_with_fallback tool "$body")"
  report_completion tool "tool call" tool "$elapsed" 1

  # 4c. json_object: the raw-SDK native rung in src/lib/openai.ts. Advisory,
  # because Day0's ladder falls back to prompt mode when a server declines it.
  body="$(build_body 'Return a JSON object with keys title (string) and priority (low or high) for a task about refreshing a sales tracker.' ',"response_format":{"type":"json_object"}')"
  elapsed="$(post_chat_with_fallback json_object "$body")"
  report_completion json_object "response_format json_object" json "$elapsed" 0

  # 4d. json_schema with strict: what @ai-sdk/openai sends for Mastra's native
  # structured output. Advisory for the same reason.
  schema='"response_format":{"type":"json_schema","json_schema":{"name":"work_item","strict":true,"schema":{"type":"object","properties":{"title":{"type":"string"},"priority":{"type":"string","enum":["low","high"]}},"required":["title","priority"],"additionalProperties":false}}}'
  body="$(build_body 'Describe a task about refreshing a sales tracker.' ",${schema}")"
  elapsed="$(post_chat_with_fallback json_schema "$body")"
  report_completion json_schema "response_format json_schema" json "$elapsed" 0
fi

# ---------------------------------------------------------------------------
# 5. Reference hosts. Unauthenticated, reachability only. A 401 or 403 means
# the host answered; a 403 carrying unsupported_country_region_territory is
# the provider saying this network is outside its supported regions, which is
# a policy fact as well as a network one.
# ---------------------------------------------------------------------------
if [ "$REFERENCE" -eq 1 ]; then
  section "5. Reference hosts (reachability only; not a permission check)"
  probe_ref() {
    # probe_ref LABEL URL
    local label="$1" url="$2" out code
    out="$TMPDIR_PROBE/ref.$$.$RANDOM"
    : > "$out"
    code="$(curl -sS -o "$out" --max-time "$TIMEOUT" -w '%{http_code}' "$url" 2>"$out.err" || true)"
    code="${code:-000}"
    if [ "$code" = "000" ]; then
      record note "$label" "unreachable: $(trim 120 < "$out.err")"
    elif grep -q 'unsupported_country_region_territory' "$out" 2>/dev/null; then
      record note "$label" "HTTP ${code}; provider reports this network as an unsupported region"
    else
      record info "$label" "HTTP ${code} (answered)"
    fi
  }
  probe_ref "api.openai.com" "https://api.openai.com/v1/models"
  probe_ref "api.anthropic.com" "https://api.anthropic.com/v1/models"
  probe_ref "api.z.ai (international)" "https://api.z.ai/api/paas/v4/models"
  probe_ref "open.bigmodel.cn (China)" "https://open.bigmodel.cn/api/paas/v4/models"
  probe_ref "slack.com" "https://slack.com/api/api.test"
  probe_ref "mcp.linear.app" "https://mcp.linear.app/"
  probe_ref "api.notion.com" "https://api.notion.com/v1/users/me"
  probe_ref "registry.npmjs.org" "https://registry.npmjs.org/-/ping"
  probe_ref "ghcr.io" "https://ghcr.io/v2/"
fi

# ---------------------------------------------------------------------------
# Summary and tier
# ---------------------------------------------------------------------------
section "Summary"
passes=0; fails=0; notes=0; skips=0
i=0
while [ "$i" -lt "${#RESULT_TAGS[@]}" ]; do
  case "${RESULT_TAGS[$i]}" in
    pass) passes=$((passes + 1)) ;;
    FAIL) fails=$((fails + 1)) ;;
    note) notes=$((notes + 1)) ;;
    skip) skips=$((skips + 1)) ;;
  esac
  i=$((i + 1))
done
echo "pass ${passes}, fail ${fails}, note ${notes}, pending ${skips}"

tier=""
if [ "$fails" -eq 0 ] && [ "$skips" -eq 0 ]; then
  tier="tier 1: ${HOST} serves ${MODEL} from this network with a key; a live model rung can run here"
elif [ "$fails" -eq 0 ]; then
  tier="tier 2: ${HOST} is reachable from this network; authenticated inference is pending the key"
elif [ "$AUTH_REJECTED" -eq 1 ]; then
  tier="tier 2: ${HOST} answers from this network but rejected the key (401/403); the network is not the problem, the key or the plan is"
else
  tier="tier 3: a required step failed; run the offline rung (warm bed, recorded run, revocation trial) and try the next network path (roaming SIM, hotspot) before retrying"
fi
echo "$tier"
echo
echo "Reachability is not permission. Whether a provider may be used from this"
echo "location is a question for that provider's supported-region terms."

if [ "$FAILED" -eq 1 ]; then exit 2; fi
exit 0
