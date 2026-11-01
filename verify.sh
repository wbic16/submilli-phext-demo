#!/usr/bin/env bash
#
# End-to-end verification for the Submilli x Phext demo (Route B),
# Stages 1-2.
#
# Builds the package, regenerates the fixture, starts a throwaway
# submilli-server (throwaway SUBMILLI_HOME, random port, dedicated audit
# file, one operator-declared named volume), seeds a session's per-session
# directory with the fixture phext by host copy, and asserts PLAN.md
# section 7, items 1-6:
#
#   1. work.ts exits 0 with the expected summary.
#   2. work-injected-write.ts / work-injected-read.ts: the legitimate work
#      completes and prints, then the injected call is denied by name and
#      coordinate; both exit nonzero.
#   3. Under blueprint-raised.yaml, write-handbook.ts exits 0.
#   4. Host-side: the session's demo.phext on disk parses (Python parser)
#      with the findings scroll mid-file and the handbook still at V1.
#   5. Audit hygiene: no scroll text in the audit file; denied decision
#      records name the capability and the coordinate.
#   6. Persistence: under blueprint-persistent.yaml (named volume
#      "phext-memory" mounted at /phext), session A writes the findings
#      scroll; the server is stopped and restarted; a NEW session B reads
#      the scroll back and its reported checksum equals the SHA-256 of
#      the volume's demo.phext on disk, which is unchanged by the
#      read-only session B.
#
# Prerequisites: submilli + submilli-server v0.5.1 on PATH (~/.local/bin),
# Node 22+, python3, openssl, curl, sha256sum. No model keys, no network.
#
# Logs land in logs/. The throwaway state is removed on exit.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

for bin in submilli submilli-server node python3 openssl curl sha256sum; do
  command -v "$bin" >/dev/null || { echo "FAIL: prerequisite not on PATH: $bin" >&2; exit 1; }
done
[[ "$(submilli --version)" == "submilli 0.5.1" ]] || { echo "FAIL: expected submilli 0.5.1, got: $(submilli --version)" >&2; exit 1; }

WORK="$(mktemp -d "$ROOT/.verify.XXXXXX")"
export SUBMILLI_HOME="$WORK/home"
LOGDIR="$ROOT/logs"; mkdir -p "$LOGDIR"
AUDIT="$WORK/audit.log"
SERVER_LOG="$WORK/server.log"
SERVER_PID=""

unset SUBMILLI_CONFIG SUBMILLI_ALLOW_UNAUTHENTICATED SUBMILLI_SERVER_TOKEN_FILE

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    submilli server stop >/dev/null 2>&1 || true
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  cp "$AUDIT" "$LOGDIR/verify-audit.log" 2>/dev/null || true
  cp "$SERVER_LOG" "$LOGDIR/verify-server.log" 2>/dev/null || true
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

# ---------------------------------------------------------------- setup
step "fixture"
python3 fixture/make_fixture.py > "$LOGDIR/verify-fixture.log" 2>&1 \
  || { echo "FAIL: fixture build/parse-back failed (logs/verify-fixture.log)"; exit 1; }
cat "$LOGDIR/verify-fixture.log"

step "package build"
submilli build check --deny-warnings > "$LOGDIR/verify-build-check.log" 2>&1 \
  || { echo "FAIL: submilli build check (logs/verify-build-check.log)"; exit 1; }
submilli build test --deny-warnings > "$LOGDIR/verify-build-test.log" 2>&1 \
  || { echo "FAIL: submilli build test (logs/verify-build-test.log)"; exit 1; }
grep -E "passed" "$LOGDIR/verify-build-test.log" | tail -1
submilli build publish-local > "$LOGDIR/verify-publish-local.log" 2>&1 \
  || { echo "FAIL: submilli build publish-local"; exit 1; }

step "blueprint lint (no --deny-warnings; benign warnings expected)"
submilli blueprint lint blueprint.yaml > "$LOGDIR/verify-lint.log" 2>&1 \
  || { echo "FAIL: blueprint lint blueprint.yaml"; exit 1; }
submilli blueprint lint blueprint-raised.yaml > "$LOGDIR/verify-lint-raised.log" 2>&1 \
  || { echo "FAIL: blueprint lint blueprint-raised.yaml"; exit 1; }
submilli blueprint lint blueprint-persistent.yaml > "$LOGDIR/verify-lint-persistent.log" 2>&1 \
  || { echo "FAIL: blueprint lint blueprint-persistent.yaml"; exit 1; }
echo "all three blueprints valid"

step "server"
cat > "$WORK/server.yaml" <<EOF
logging:
  audit:
    file: $AUDIT
    allows: summary
volumes:
  phext-memory:
    kind: managed-local
    size_limit: 1GB
EOF
export SUBMILLI_CONFIG="$WORK/server.yaml"
PORT="$(node -e 'const net=require("net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});')"
export SUBMILLI_BIND=127.0.0.1 SUBMILLI_PORT="$PORT" SUBMILLI_SERVER_URL="http://127.0.0.1:$PORT"
export SUBMILLI_SERVER_TOKEN="$(openssl rand -hex 32)"
if curl -sS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null; then
  echo "FAIL: something is already listening on $SUBMILLI_SERVER_URL"; exit 1
fi
submilli-server > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -fsS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "FAIL: server exited early (logs/verify-server.log)"; exit 1; }
  sleep 0.2
done
submilli server status >/dev/null || { echo "FAIL: server not healthy"; exit 1; }
submilli server blueprint apply blueprint.yaml >/dev/null || { echo "FAIL: blueprint apply"; exit 1; }
echo "server up on $SUBMILLI_SERVER_URL, blueprint 'phext-demo' applied"

seed_session() { # echoes the new session id; seeds its per-session dir
  local sid sdir
  sid="$(node app.mjs --open-session | sed -n 's/^\[session\] //p')"
  [[ -n "$sid" ]] || return 1
  sdir="$SUBMILLI_HOME/server/volumes/sessions/$sid"
  [[ -d "$sdir" ]] || return 1
  mkdir -p "$sdir/phext"
  cp fixture/demo.phext "$sdir/phext/demo.phext"
  printf '%s' "$sid"
}

# ------------------------------------------------------- session A: 1,2,4
step "test 1: legit work (work.ts)"
SID_A="$(seed_session)" || { echo "FAIL: could not open/seed session A"; exit 1; }
echo "session A: $SID_A (seeded by host copy into its per-session dir)"
run_app --session "$SID_A" programs/work.ts > "$LOGDIR/verify-t1.log" 2>&1
T1=0
[[ $RC -eq 0 ]] || T1=1
contains "$OUT" "[result]" || T1=1
contains "$OUT" "toc=4" || T1=1
contains "$OUT" "handbook-first-words=HANDBOOK-TRIAGE-V1 Support triage" || T1=1
contains "$OUT" "findings-at=1.1.1/1.2.1/1.1.2 readback=ok" || T1=1
record "1 legit program exits 0 with the expected summary" "$T1" "rc=$RC; see logs/verify-t1.log"

step "test 2a: injected handbook write is denied (work-injected-write.ts)"
run_app --session "$SID_A" programs/work-injected-write.ts > "$LOGDIR/verify-t2a.log" 2>&1
T2A=0
[[ $RC -ne 0 ]] || T2A=1
contains "$OUT" "[program] findings written and read back at 1.1.1/1.2.1/1.1.2" || T2A=1
contains "$OUT" "[denied]" || T2A=1
contains "$OUT" "phext.example/scrolls.write" || T2A=1
contains "$OUT" 'coordinate = "1.1.1/1.1.1/1.1.1"' || T2A=1
not_contains "$OUT" "[result]" || T2A=1
record "2a legit work completes, injected write denied by capability+coordinate, exit nonzero" "$T2A" "rc=$RC; see logs/verify-t2a.log"

step "test 2b: injected cross-lane read is denied (work-injected-read.ts)"
run_app --session "$SID_A" programs/work-injected-read.ts > "$LOGDIR/verify-t2b.log" 2>&1
T2B=0
[[ $RC -ne 0 ]] || T2B=1
contains "$OUT" "[program] findings written and read back at 1.1.1/1.2.1/1.1.2" || T2B=1
contains "$OUT" "[denied]" || T2B=1
contains "$OUT" "phext.example/scrolls.select" || T2B=1
contains "$OUT" 'coordinate = "1.1.1/1.3.1/1.1.1"' || T2B=1
not_contains "$OUT" "OTHER-SESSION-NOTES" || T2B=1
not_contains "$OUT" "[result]" || T2B=1
record "2b legit work completes, injected read denied by capability+coordinate, exit nonzero" "$T2B" "rc=$RC; see logs/verify-t2b.log"

step "test 4: host-side proof (Python parser on the session file)"
cp "$SUBMILLI_HOME/server/volumes/sessions/$SID_A/phext/demo.phext" "$WORK/session-a.phext"
if python3 - "$WORK/session-a.phext" > "$LOGDIR/verify-t4.log" 2>&1 <<'PYEOF'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location(
    "parse_phext", pathlib.Path.home() / "workspace" / "phext" / "parse_phext.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
scrolls = dict(mod.parse(sys.argv[1]))
assert len(scrolls) == 5, f"expected 5 scrolls, got {len(scrolls)}: {sorted(scrolls)}"
findings = scrolls.get("1.1.1/1.2.1/1.1.2", "")
assert "Findings after reviewing the triage handbook" in findings, "findings scroll missing/wrong"
assert "three steps" in findings, "findings scroll content incomplete"
assert scrolls["1.1.1/1.1.1/1.1.1"].startswith("HANDBOOK-TRIAGE-V1"), "handbook changed in the non-raised run"
assert "OTHER-SESSION-NOTES" in scrolls["1.1.1/1.3.1/1.1.1"], "other-session scroll damaged"
assert scrolls["1.1.1/1.2.1/1.1.1"] == "Session opened. No findings yet.", "session seed scroll damaged"
print("host parse OK: findings mid-file at 1.1.1/1.2.1/1.1.2, handbook still V1, other scrolls intact")
PYEOF
then T4=0; else T4=1; fi
record "4 session phext on disk: findings at coordinate, handbook still V1" "$T4" "see logs/verify-t4.log"

# ------------------------------------------------------------- test 3
step "test 3: the raise (blueprint-raised.yaml + write-handbook.ts)"
submilli server blueprint apply blueprint-raised.yaml >/dev/null || { echo "FAIL: raised blueprint apply"; exit 1; }
SID_B="$(seed_session)" || { echo "FAIL: could not open/seed session B"; exit 1; }
echo "session B: $SID_B (fresh seed, raised blueprint in force)"
run_app --session "$SID_B" programs/write-handbook.ts > "$LOGDIR/verify-t3.log" 2>&1
T3=0
[[ $RC -eq 0 ]] || T3=1
contains "$OUT" "handbook updated at 1.1.1/1.1.1/1.1.1" || T3=1
contains "$OUT" "HANDBOOK-TRIAGE-V2" || T3=1
if [[ $T3 -eq 0 ]]; then
  python3 - "$SUBMILLI_HOME/server/volumes/sessions/$SID_B/phext/demo.phext" >> "$LOGDIR/verify-t3.log" 2>&1 <<'PYEOF' || T3=1
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location(
    "parse_phext", pathlib.Path.home() / "workspace" / "phext" / "parse_phext.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
scrolls = dict(mod.parse(sys.argv[1]))
assert scrolls["1.1.1/1.1.1/1.1.1"].startswith("HANDBOOK-TRIAGE-V2"), "raised write did not land on disk"
print("host parse OK: handbook on disk is V2 under the raised blueprint")
PYEOF
fi
record "3 raised blueprint lets the handbook write through (exit 0, V2 on disk)" "$T3" "rc=$RC; see logs/verify-t3.log"
submilli server blueprint apply blueprint.yaml >/dev/null || echo "WARN: could not re-apply the original blueprint"

# ------------------------------------------------------------- test 5
step "test 5: audit hygiene"
submilli server stop >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
sleep 0.3
T5=0
[[ -s "$AUDIT" ]] || T5=1
if grep -q "HANDBOOK-TRIAGE-V1" "$AUDIT" 2>/dev/null; then T5=1; fi
if grep -q "OTHER-SESSION-NOTES" "$AUDIT" 2>/dev/null; then T5=1; fi
grep "decision=deny" "$AUDIT" 2>/dev/null | grep -q "phext.example/scrolls.write" || T5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep "phext.example/scrolls.write" | grep -q '1.1.1/1.1.1/1.1.1' || T5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep -q "phext.example/scrolls.select" || T5=1
grep "decision=deny" "$AUDIT" 2>/dev/null | grep "phext.example/scrolls.select" | grep -q '1.1.1/1.3.1/1.1.1' || T5=1
record "5 audit holds no scroll text; denied decisions name capability+coordinate" "$T5" "see logs/verify-audit.log (copied at cleanup)"

# ------------------------------------------------------------- test 6
# Server restart helpers for the persistence test (same home, same
# config, same port/token as the first boot; log appended).
start_server() {
  if curl -sS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null; then
    echo "FAIL: something is already listening on $SUBMILLI_SERVER_URL"; exit 1
  fi
  submilli-server >> "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 100); do
    curl -fsS -o /dev/null "$SUBMILLI_SERVER_URL/healthz" 2>/dev/null && break
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "FAIL: server exited early (logs/verify-server.log)"; exit 1; }
    sleep 0.2
  done
  submilli server status >/dev/null || { echo "FAIL: server not healthy"; exit 1; }
}
stop_server() {
  submilli server stop >/dev/null 2>&1 || true
  if [[ -n "$SERVER_PID" ]]; then
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
  sleep 0.3
}

step "test 6: persistence across a server restart (named volume at /phext)"
VOL_DIR="$SUBMILLI_HOME/server/volumes/managed-local/phext-memory"
VOL_FILE="$VOL_DIR/demo.phext"
T6=0
start_server
submilli server blueprint apply blueprint-persistent.yaml >/dev/null || T6=1
# Empirical (Stage 2): the server creates managed-local/phext-memory at
# startup, before any session opens, so the volume is seeded directly,
# independent of any session's per-session directory.
[[ -d "$VOL_DIR" ]] || T6=1
cp fixture/demo.phext "$VOL_FILE" || T6=1
SID_PA="$(node app.mjs --blueprint phext-demo-persistent --open-session | sed -n 's/^\[session\] //p')"
[[ -n "$SID_PA" ]] || T6=1
echo "persistent session A: $SID_PA (volume seeded by host copy before the session opened)"
if [[ $T6 -eq 0 ]]; then
  run_app --session "$SID_PA" programs/work.ts > "$LOGDIR/verify-t6a.log" 2>&1
  [[ $RC -eq 0 ]] || T6=1
  contains "$OUT" "findings-at=1.1.1/1.2.1/1.1.2 readback=ok" || T6=1
fi
H1=""
if [[ $T6 -eq 0 ]]; then
  H1="$(sha256sum "$VOL_FILE" | awk '{print $1}')"
  python3 - "$VOL_FILE" > "$LOGDIR/verify-t6-host.log" 2>&1 <<'PYEOF' || T6=1
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location(
    "parse_phext", pathlib.Path.home() / "workspace" / "phext" / "parse_phext.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
scrolls = dict(mod.parse(sys.argv[1]))
assert len(scrolls) == 5, f"expected 5 scrolls, got {len(scrolls)}: {sorted(scrolls)}"
assert "Findings after reviewing the triage handbook" in scrolls.get("1.1.1/1.2.1/1.1.2", ""), \
    "findings scroll missing from the volume phext"
print("host parse OK: findings at 1.1.1/1.2.1/1.1.2 in the volume phext")
PYEOF
  echo "volume phext after session A: sha256=$H1"
fi
stop_server
start_server
# Blueprints are registered in the server's own store and survive a
# restart; only re-apply if this one somehow did not.
if submilli server blueprint list 2>/dev/null | grep -qx "phext-demo-persistent"; then
  echo "blueprint 'phext-demo-persistent' survived the restart; no re-apply needed"
else
  echo "note: blueprint did not survive the restart; re-applying"
  submilli server blueprint apply blueprint-persistent.yaml >/dev/null || T6=1
fi
SID_PB="$(node app.mjs --blueprint phext-demo-persistent --open-session | sed -n 's/^\[session\] //p')"
[[ -n "$SID_PB" && "$SID_PB" != "$SID_PA" ]] || T6=1
echo "persistent session B: $SID_PB (fresh session id, opened after the restart)"
if [[ $T6 -eq 0 ]]; then
  run_app --session "$SID_PB" programs/readback.ts > "$LOGDIR/verify-t6b.log" 2>&1
  [[ $RC -eq 0 ]] || T6=1
  contains "$OUT" "findings=Findings after reviewing the triage handbook" || T6=1
  contains "$OUT" "record findings in the session lane" || T6=1
  contains "$OUT" "checksum=$H1" || T6=1
fi
H2="$(sha256sum "$VOL_FILE" 2>/dev/null | awk '{print $1}')"
[[ -n "$H1" && "$H2" == "$H1" ]] || T6=1
cp "$VOL_FILE" "$LOGDIR/verify-t6-volume.phext" 2>/dev/null || true
record "6 persistence: new session after server restart reads prior session's scroll; checksum matches disk" "$T6" "see logs/verify-t6a.log, logs/verify-t6b.log, logs/verify-t6-host.log"
stop_server

# ------------------------------------------------------------- summary
step "summary"
FAILED=0
for line in "${RESULTS[@]}"; do
  printf '%s\n' "$line"
  [[ "$line" == FAIL* ]] && FAILED=1
done
if [[ $FAILED -eq 0 ]]; then
  printf '\n\033[32mPASS\033[0m  all Stage-1 + Stage-2 checks passed.\n'
  exit 0
fi
printf '\n\033[31mFAIL\033[0m  one or more checks failed (see logs/).\n'
exit 1
