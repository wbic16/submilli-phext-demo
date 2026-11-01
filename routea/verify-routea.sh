#!/usr/bin/env bash
#
# End-to-end verification for the Submilli x Phext demo, Route A
# (SQ over HTTP) — the variant in this directory.
#
# THE INVARIANT UNDER TEST (Will): when the store becomes HTTP, the
# runtime has to be the only thing holding the SQ key. If the key can
# reach the sandbox, the capability model leaks and the demo proves
# nothing. So this script does not just check that the demo works —
# it attacks the key from inside the sandbox and sweeps the disk for
# it afterwards (test A3).
#
# Orchestration (all throwaway, random ports, cleaned up on exit):
#   - SQ v0.6.0: `sq host <port> --key <SENTINEL> --data-dir <tmp>`,
#     serving a copy of the fixture phext. SENTINEL is generated per
#     run and never written to any file by this script.
#   - submilli-server v0.5.1: throwaway SUBMILLI_HOME, secret-store
#     key configured (so the store is encrypted), network.allow_
#     localhost on, dedicated audit file. The operator puts the
#     SENTINEL into the store as SQ_API_KEY before any blueprint is
#     applied. The key then exists in exactly two processes: SQ's and
#     the runtime's.
#   - The @wbic16/phext package is published into the throwaway home
#     with --config sqBaseUrl=http://127.0.0.1:<sq port> (the base URL
#     is inspectable configuration, not a secret).
#
# Tests:
#   A0  the Route A blueprint's `main` permissions are byte-identical
#       to Route B's (stage1/blueprint.yaml) — the backend swap does
#       not change what the program may do.
#   A1  work.ts returns the SAME summary string as Route B.
#   A2  both injected programs are denied with the same capability +
#       coordinate shapes as Route B tests 2a/2b.
#   A3  THE KEY INVARIANT:
#       a probe-secrets.ts under a blueprint that GRANTS main
#          secrets.get is still refused by the runtime, verbatim;
#       b probe-http.ts (direct SQ call from main, no key) is denied
#          by policy before it leaves the sandbox;
#       c SQ itself gates: no key -> 401, wrong key -> 401, the
#          runtime's key -> 200 (the key is load-bearing);
#       d sentinel sweep: the per-run key appears in ZERO files —
#          this tree, the stage1 tree, the throwaway home, server
#          logs, the audit file, the SQ data dir, all program outputs.
#   A4  host-side proof: operator-side SQ select (with the key) shows
#       the findings scroll; the phext file on disk in SQ's data dir
#       changed and the Python parser agrees on its contents.
#   A5  audit hygiene: denied decisions name capability+coordinate;
#       no scroll text and no key in the audit file.
#
# Prerequisites: submilli + submilli-server v0.5.1 (~/.local/bin),
# sq v0.6.0 (~/.cargo/bin), Node 22+, python3, openssl, curl,
# sha256sum. No model keys. Logs land in logs/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE1="$(cd "$ROOT/../stage1" && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

for bin in submilli submilli-server sq node python3 openssl curl sha256sum; do
  command -v "$bin" >/dev/null || { echo "FAIL: prerequisite not on PATH: $bin" >&2; exit 1; }
done
[[ "$(submilli --version)" == "submilli 0.5.1" ]] || { echo "FAIL: expected submilli 0.5.1, got: $(submilli --version)" >&2; exit 1; }

WORK="$(mktemp -d "$ROOT/.verify-routea.XXXXXX")"
export SUBMILLI_HOME="$WORK/home"
LOGDIR="$ROOT/logs"; mkdir -p "$LOGDIR"
AUDIT="$WORK/audit.log"
SERVER_LOG="$WORK/server.log"
SQ_LOG="$WORK/sq.log"
SQDATA="$WORK/sqdata"; mkdir -p "$SQDATA"
SERVER_PID=""; SQ_PID=""

unset SUBMILLI_CONFIG SUBMILLI_ALLOW_UNAUTHENTICATED SUBMILLI_SERVER_TOKEN_FILE

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    submilli server stop >/dev/null 2>&1 || true
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SQ_PID" ]] && kill -0 "$SQ_PID" 2>/dev/null; then
    kill "$SQ_PID" 2>/dev/null || true
    wait "$SQ_PID" 2>/dev/null || true
  fi
  cp "$AUDIT" "$LOGDIR/verify-routea-audit.log" 2>/dev/null || true
  cp "$SERVER_LOG" "$LOGDIR/verify-routea-server.log" 2>/dev/null || true
  cp "$SQ_LOG" "$LOGDIR/verify-routea-sq.log" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

declare -a RESULTS=()
record() { # record <test-name> <0=pass|1=fail> <detail>
  if [[ "$2" == "0" ]]; then
    RESULTS+=("PASS  $1")
    printf 'PASS  %s\n' "$1"
  else
    RESULTS+=("FAIL  $1  -- $3")
    printf 'FAIL  %s  -- %s\n' "$1" "$3"
  fi
}
contains() { [[ "$1" == *"$2"* ]]; }
not_contains() { [[ "$1" != *"$2"* ]]; }

OUT=""; RC=0
run_app() { OUT="$(node app.mjs "$@" 2>&1)"; RC=$?; printf '%s\n' "$OUT"; }

step() { printf '\n# %s\n' "$*"; }
free_port() { node -e 'const net=require("net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});'; }

# ---------------------------------------------------------------- setup
step "fixture"
python3 fixture/make_fixture.py > "$LOGDIR/verify-routea-fixture.log" 2>&1 \
  || { echo "FAIL: fixture build/parse-back failed (logs/verify-routea-fixture.log)"; exit 1; }
cat "$LOGDIR/verify-routea-fixture.log"
FIXTURE_SHA="$(sha256sum fixture/demo.phext | awk '{print $1}')"
cp fixture/demo.phext "$SQDATA/demo.phext"

step "package build (engine tests; dummy sqBaseUrl — no SQ in build tests)"
DUMMY_CFG="sqBaseUrl=http://127.0.0.1:9"
submilli build check --deny-warnings -p @wbic16/phext --config "$DUMMY_CFG" > "$LOGDIR/verify-routea-build-check.log" 2>&1 \
  || { echo "FAIL: submilli build check (logs/verify-routea-build-check.log)"; exit 1; }
submilli build test --deny-warnings -p @wbic16/phext --config "$DUMMY_CFG" > "$LOGDIR/verify-routea-build-test.log" 2>&1 \
  || { echo "FAIL: submilli build test (logs/verify-routea-build-test.log)"; exit 1; }
grep -E "passed" "$LOGDIR/verify-routea-build-test.log" | tail -1
if grep -q "fs\." package/capabilities.yaml; then
  echo "FAIL: capabilities.yaml mentions fs — the Route A artifact must require only http.* + secrets.get"; exit 1
fi
grep -A10 "^requires:" package/capabilities.yaml
echo "artifact requires only http.* + secrets.get — no fs anywhere"

step "A0: main permissions byte-identical to Route B"
if python3 - "$STAGE1/blueprint.yaml" blueprint-routea.yaml > "$LOGDIR/verify-routea-main-diff.log" 2>&1 <<'PYEOF'
import sys

def main_section(path):
    lines = open(path).read().splitlines(keepends=True)
    out, inside = [], False
    for line in lines:
        if line.startswith("  main:"):
            inside = True
        elif inside and line.startswith("  '@wbic16/phext':"):
            break
        if inside:
            out.append(line)
    return "".join(out)

a, b = main_section(sys.argv[1]), main_section(sys.argv[2])
if a != b:
    print("MAIN SECTIONS DIFFER")
    sys.exit(1)
print("main sections byte-identical (" + str(len(a)) + " bytes)")
PYEOF
then TA0=0; else TA0=1; fi
cat "$LOGDIR/verify-routea-main-diff.log"
record "A0 main permissions byte-identical to Route B blueprint" "$TA0" "see logs/verify-routea-main-diff.log"

step "SQ (operator side, keyed)"
SQPORT="$(free_port)"
SENTINEL="SQKEY-SENTINEL-$(openssl rand -hex 8)"
( cd "$SQDATA" && exec sq host "$SQPORT" --key "$SENTINEL" --data-dir "$SQDATA" ) > "$SQ_LOG" 2>&1 &
SQ_PID=$!
SQREADY=""
for _ in $(seq 1 50); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SENTINEL" "http://127.0.0.1:$SQPORT/api/v2/version?p=demo" 2>/dev/null || true)"
  [[ "$code" == "200" ]] && { SQREADY=1; break; }
  kill -0 "$SQ_PID" 2>/dev/null || break
  sleep 0.2
done
[[ -n "$SQREADY" ]] || { echo "FAIL: SQ did not come up authed (logs/verify-routea-sq.log via cleanup)"; exit 1; }
echo "SQ up on 127.0.0.1:$SQPORT, serving demo.phext from its data dir, key required"

step "submilli-server (operator side, encrypted secret store)"
cat > "$WORK/server.yaml" <<EOF
logging:
  audit:
    file: $AUDIT
    allows: summary
network:
  allow_localhost: true
EOF
export SUBMILLI_CONFIG="$WORK/server.yaml"
PORT="$(free_port)"
export SUBMILLI_BIND=127.0.0.1 SUBMILLI_PORT="$PORT" SUBMILLI_SERVER_URL="http://127.0.0.1:$PORT"
export SUBMILLI_SERVER_TOKEN="$(openssl rand -hex 32)"
export SUBMILLI_SECRET_KEY="$(head -c 32 /dev/urandom | base64)"
if curl -sS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null; then
  echo "FAIL: something is already listening on $SUBMILLI_SERVER_URL"; exit 1
fi
submilli-server > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -fsS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "FAIL: server exited early"; exit 1; }
  sleep 0.2
done
submilli server status >/dev/null || { echo "FAIL: server not healthy"; exit 1; }
# The operator puts the SQ key into the runtime's encrypted store.
# From here on it exists in exactly two processes: SQ and the runtime.
printf %s "$SENTINEL" | submilli server secret put SQ_API_KEY >/dev/null \
  || { echo "FAIL: secret put (is the secret store configured?)"; exit 1; }
submilli build publish-local -p @wbic16/phext --config sqBaseUrl="http://127.0.0.1:$SQPORT" > "$LOGDIR/verify-routea-publish.log" 2>&1 \
  || { echo "FAIL: publish-local with sqBaseUrl config"; exit 1; }
submilli blueprint lint blueprint-routea.yaml > "$LOGDIR/verify-routea-lint.log" 2>&1 \
  || { echo "FAIL: lint blueprint-routea.yaml"; exit 1; }
submilli blueprint lint blueprint-routea-permissive.yaml > "$LOGDIR/verify-routea-lint-permissive.log" 2>&1 \
  || { echo "FAIL: lint blueprint-routea-permissive.yaml"; exit 1; }
submilli server blueprint apply blueprint-routea.yaml >/dev/null || { echo "FAIL: apply routea blueprint"; exit 1; }
submilli server blueprint apply blueprint-routea-permissive.yaml >/dev/null || { echo "FAIL: apply permissive blueprint"; exit 1; }
echo "server up on $SUBMILLI_SERVER_URL; SQ_API_KEY in the encrypted store; both blueprints applied"

SID="$(node app.mjs --blueprint phext-demo-routea --open-session | sed -n 's/^\[session\] //p')"
[[ -n "$SID" ]] || { echo "FAIL: could not open Route A session"; exit 1; }
echo "session: $SID (blueprint phext-demo-routea; the phext lives in SQ, nothing seeded here)"

# ------------------------------------------------------------------- A1
step "A1: legit work (work.ts) — same summary as Route B"
run_app --blueprint phext-demo-routea --session "$SID" programs/work.ts > "$LOGDIR/verify-routea-a1.log" 2>&1
TA1=0
[[ $RC -eq 0 ]] || TA1=1
contains "$OUT" "[result]" || TA1=1
contains "$OUT" "toc=4 handbook-first-words=HANDBOOK-TRIAGE-V1 Support triage findings-at=1.1.1/1.2.1/1.1.2 readback=ok" || TA1=1
record "A1 legit program exits 0 with the exact Route B summary" "$TA1" "rc=$RC; see logs/verify-routea-a1.log"

# ------------------------------------------------------------------- A2
step "A2a: injected handbook write is denied (work-injected-write.ts)"
run_app --blueprint phext-demo-routea --session "$SID" programs/work-injected-write.ts > "$LOGDIR/verify-routea-a2a.log" 2>&1
TA2A=0
[[ $RC -ne 0 ]] || TA2A=1
contains "$OUT" "[program] findings written and read back at 1.1.1/1.2.1/1.1.2" || TA2A=1
contains "$OUT" "[denied]" || TA2A=1
contains "$OUT" "phext.example/scrolls.write" || TA2A=1
contains "$OUT" 'coordinate = "1.1.1/1.1.1/1.1.1"' || TA2A=1
not_contains "$OUT" "[result]" || TA2A=1
record "A2a legit work completes, injected write denied by capability+coordinate, exit nonzero" "$TA2A" "rc=$RC; see logs/verify-routea-a2a.log"

step "A2b: injected cross-lane read is denied (work-injected-read.ts)"
run_app --blueprint phext-demo-routea --session "$SID" programs/work-injected-read.ts > "$LOGDIR/verify-routea-a2b.log" 2>&1
TA2B=0
[[ $RC -ne 0 ]] || TA2B=1
contains "$OUT" "[program] findings written and read back at 1.1.1/1.2.1/1.1.2" || TA2B=1
contains "$OUT" "[denied]" || TA2B=1
contains "$OUT" "phext.example/scrolls.select" || TA2B=1
contains "$OUT" 'coordinate = "1.1.1/1.3.1/1.1.1"' || TA2B=1
not_contains "$OUT" "OTHER-SESSION-NOTES" || TA2B=1
not_contains "$OUT" "[result]" || TA2B=1
record "A2b legit work completes, injected read denied by capability+coordinate, exit nonzero" "$TA2B" "rc=$RC; see logs/verify-routea-a2b.log"

# ------------------------------------------------------------------ A3b
step "A3b: probe — direct SQ call from main is denied by policy"
sed "s/__SQ_PORT__/$SQPORT/" programs/probe-http.ts.tmpl > "$WORK/probe-http.ts"
run_app --blueprint phext-demo-routea --session "$SID" "$WORK/probe-http.ts" > "$LOGDIR/verify-routea-a3b.log" 2>&1
TA3B=0
[[ $RC -ne 0 ]] || TA3B=1
contains "$OUT" "[denied]" || TA3B=1
contains "$OUT" "capability=http.get" || TA3B=1
contains "$OUT" "policy denied http.get for main" || TA3B=1
not_contains "$OUT" "HANDBOOK-TRIAGE-V1" || TA3B=1
not_contains "$OUT" "INVARIANT BROKEN" || TA3B=1
record "A3b main holds no http rules: direct SQ call denied by policy, no content returned" "$TA3B" "rc=$RC; see logs/verify-routea-a3b.log"

# ------------------------------------------------------------------ A3a
step "A3a: probe — secrets.get from main, under a blueprint that GRANTS it"
SIDP="$(node app.mjs --blueprint phext-demo-routea-permissive --open-session | sed -n 's/^\[session\] //p')"
[[ -n "$SIDP" ]] || { echo "FAIL: could not open permissive session"; exit 1; }
run_app --blueprint phext-demo-routea-permissive --session "$SIDP" programs/probe-secrets.ts > "$LOGDIR/verify-routea-a3a.log" 2>&1
TA3A=0
[[ $RC -ne 0 ]] || TA3A=1
contains "$OUT" "secret values are never available to main-module code, and no policy can grant this" || TA3A=1
not_contains "$OUT" "OBTAINED" || TA3A=1
not_contains "$OUT" "$SENTINEL" || TA3A=1
record "A3a secrets.get from main refused by runtime invariant, even under a granting blueprint" "$TA3A" "rc=$RC; see logs/verify-routea-a3a.log"

# ------------------------------------------------------------------ A3c
step "A3c: SQ itself gates on the key"
CODE_NOKEY="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SQPORT/api/v2/select?p=demo&c=1.1.1/1.1.1/1.1.1")"
CODE_WRONG="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-key-on-purpose" "http://127.0.0.1:$SQPORT/api/v2/select?p=demo&c=1.1.1/1.1.1/1.1.1")"
BODY_KEY="$(curl -s -H "Authorization: Bearer $SENTINEL" "http://127.0.0.1:$SQPORT/api/v2/select?p=demo&c=1.1.1/1.1.1/1.1.1")"
TA3C=0
[[ "$CODE_NOKEY" == "401" ]] || TA3C=1
[[ "$CODE_WRONG" == "401" ]] || TA3C=1
contains "$BODY_KEY" "HANDBOOK-TRIAGE-V1" || TA3C=1
echo "no key: $CODE_NOKEY · wrong key: $CODE_WRONG · runtime's key: 200 with handbook content"
record "A3c SQ requires the key: 401 without, 401 with a wrong one, 200 with the runtime's" "$TA3C" "nokey=$CODE_NOKEY wrong=$CODE_WRONG"

# ------------------------------------------------------------------- A4
step "A4: host-side proof (operator-side SQ select + Python parse of SQ's file)"
FINDINGS="$(curl -s -H "Authorization: Bearer $SENTINEL" "http://127.0.0.1:$SQPORT/api/v2/select?p=demo&c=1.1.1/1.2.1/1.1.2")"
SQFILE="$SQDATA/demo.phext"
SQ_SHA="$(sha256sum "$SQFILE" | awk '{print $1}')"
echo "SQ data-dir phext sha256: $SQ_SHA (fixture was $FIXTURE_SHA)"
if python3 - "$SQFILE" > "$LOGDIR/verify-routea-a4.log" 2>&1 <<'PYEOF'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location(
    "parse_phext", pathlib.Path.home() / "workspace" / "phext" / "parse_phext.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
scrolls = dict(mod.parse(sys.argv[1]))
assert len(scrolls) == 5, f"expected 5 scrolls, got {len(scrolls)}: {sorted(scrolls)}"
assert "Findings after reviewing the triage handbook" in scrolls.get("1.1.1/1.2.1/1.1.2", ""), \
    "findings scroll missing from SQ's phext"
assert scrolls["1.1.1/1.1.1/1.1.1"].startswith("HANDBOOK-TRIAGE-V1"), "handbook changed"
assert "OTHER-SESSION-NOTES" in scrolls["1.1.1/1.3.1/1.1.1"], "other-session scroll damaged"
print("host parse OK: findings at 1.1.1/1.2.1/1.1.2 in SQ's phext, handbook still V1")
PYEOF
then TA4=0; else TA4=1; fi
contains "$FINDINGS" "Findings after reviewing the triage handbook" || TA4=1
[[ "$SQ_SHA" != "$FIXTURE_SHA" ]] || TA4=1
record "A4 operator-side SQ select shows findings; SQ's file changed and parses as expected" "$TA4" "see logs/verify-routea-a4.log"

# ------------------------------------------------------------------- A5
step "A5: audit hygiene"
submilli server stop >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
sleep 0.3
TA5=0
[[ -s "$AUDIT" ]] || TA5=1
if grep -q "HANDBOOK-TRIAGE-V1" "$AUDIT" 2>/dev/null; then TA5=1; fi
if grep -q "OTHER-SESSION-NOTES" "$AUDIT" 2>/dev/null; then TA5=1; fi
if grep -qa "$SENTINEL" "$AUDIT" 2>/dev/null; then TA5=1; fi
grep "decision=deny" "$AUDIT" 2>/dev/null | grep -q "phext.example/scrolls.write" || TA5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep "phext.example/scrolls.write" | grep -q '1.1.1/1.1.1/1.1.1' || TA5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep -q "phext.example/scrolls.select" || TA5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep "phext.example/scrolls.select" | grep -q '1.1.1/1.3.1/1.1.1' || TA5=1
record "A5 audit holds no scroll text and no key; denied decisions name capability+coordinate" "$TA5" "see logs/verify-routea-audit.log (copied at cleanup)"

# ------------------------------------------------------------------ A3d
step "A3d: sentinel sweep — the key must exist in ZERO files"
# Sweep every file the run touched or could have leaked into: this
# tree (incl. captured program outputs in logs/), the Route B tree,
# and the whole throwaway workdir (SUBMILLI_HOME incl. the encrypted
# store and the compiled package artifact, server log, audit file,
# SQ's data dir and log). The sentinel was generated in this shell's
# memory and passed only via process args (SQ) and stdin (secret put)
# — never written by this script. Any hit is an invariant finding.
HITS="$( { grep -r -a -l "$SENTINEL" "$ROOT" "$STAGE1" "$WORK" 2>/dev/null || true; } )"
TA3D=0
if [[ -n "$HITS" ]]; then
  TA3D=1
  echo "SENTINEL FOUND IN FILES (invariant finding — paths only):"
  printf '%s\n' "$HITS"
fi
record "A3d sentinel sweep: SQ key present in zero files (trees, homes, logs, audit, SQ data, outputs)" "$TA3D" "hits: $HITS"

# ------------------------------------------------------------- summary
step "summary"
FAILED=0
for line in "${RESULTS[@]}"; do
  printf '%s\n' "$line"
  [[ "$line" == FAIL* ]] && FAILED=1
done
if [[ $FAILED -eq 0 ]]; then
  printf '\n\033[32mPASS\033[0m  all Route A checks passed.\n'
  exit 0
fi
printf '\n\033[31mFAIL\033[0m  one or more Route A checks failed (see logs/).\n'
exit 1
