# Stage 1 Build Report — Submilli × Phext Demo v1 (Route B)

**Date:** 2026-11-01 · **Built in:** `~/workspace/submilli-phext/stage1/` ·
**Sources of truth:** `../PLAN.md` v0.2, `../stage0/SPIKE-REPORT.md` ·
**Binaries:** Submilli v0.5.1 (pinned), Node v24.22.1 ·
**Verdict: all Stage-1 checks PASS** (verify.sh run twice, exit 0 both times).

## What was built

Copied from the Stage-0 spike (stage0/ untouched) and evolved in place:

| Path | Contents |
|---|---|
| `submilli.toml`, `package/` | The `@wbic16/phext` project. `src/lib.ts`: ops `toc` / `readScroll` / `writeScroll` / `checksum` with the exact PLAN §3 capabilities and per-op payloads. `src/phext.ts`: the engine, extended (deviation 1). `docs/readme.md` rewritten model-facing (concepts: phextId+coordinate identity, lanes, whole-scroll writes, denial etiquette); `README.md` rewritten for installers (no credentials; grant lists). |
| `package/tests/lib.test.ts` | Spike's 4 tests + 2 new labels: lane-derivation boundary cases; mid-file insertion between existing entries. **6 passed, 0 failed** under `build test --deny-warnings`; `build check --deny-warnings` clean. Derived `capabilities.yaml` byte-identical to the spike's. |
| `fixture/make_fixture.py`, `fixture/demo.phext` | Fixture built with the Python parser's byte model (scroll `0x17`, volume `0x1C` steps), parse-back verified by `parse_phext.parse`. 517 bytes, 4 scrolls; SHA-256 `7abb8e5123b7082d202d9a45365ef08507cae570a6dfb84896d232c13488d831`. |
| `blueprint.yaml` | PLAN §5 as amended, plus deviation 2. Lints exit 0 without `--deny-warnings` (4 benign warnings, as designed). |
| `blueprint-raised.yaml` | Same name + one added `main` rule: `scrolls.write` with `coordinate glob "1.1.1/1.1.1/*"`. Lints exit 0. |
| `app.mjs` | Quickstart shape (same denial handling incl. the v0.2.0 `runtime_error` form), binds `{ phextId: "demo", lane: "1.1.1/1.2.1" }`. Modes: one-off `PROGRAM`, `--open-session`, `--session ID PROGRAM` (deviation 3). |
| `programs/` | `work.ts`, `work-injected-write.ts`, `work-injected-read.ts`, `write-handbook.ts` — as specified; legit steps share one findings text so test evidence is comparable. |
| `verify.sh` | Throwaway `SUBMILLI_HOME` + random port + `openssl` token + config file setting `logging.audit.file` into the throwaway dir (`allows: summary`), cleanup trap, per-test PASS/FAIL, logs to `logs/`. |
| `README.md`, `.gitignore` | Demo documentation; ignores local homes/verify state. |

## Seeding route — chosen: host copy into the per-session directory

Empirically established before verify.sh was written (throwaway server,
since removed):

1. `POST /v1/sessions` (via `node app.mjs --open-session`) returns a
   session id, and the directory `$SUBMILLI_HOME/server/volumes/sessions/<id>/`
   **exists immediately** — the volume-dir help text's
   `sessions/<session id>` layout is the real one.
2. `mkdir -p <dir>/phext && cp fixture/demo.phext <dir>/phext/demo.phext`
   before any program runs; the package's fs root for that session is
   exactly that directory, so `/phext/demo.phext` resolves to the copy.
3. All programs then ran against the seeded file, and the package's
   writes landed in the same file on disk (host-side parse evidence in
   test 4).

The fallback (bootstrap program under a setup blueprint) was **not**
needed. One timing note: seeding must happen after session open (the
directory is per-session) and before the first program run in it.

## verify.sh results (verbatim summary, run 1; run 2 identical)

```
6 passed, 0 failed across 1 files                       (package build tests)
demo.phext: 517 bytes, 4 scrolls, parse-back OK
sha256: 7abb8e5123b7082d202d9a45365ef08507cae570a6dfb84896d232c13488d831

PASS  1 legit program exits 0 with the expected summary
PASS  2a legit work completes, injected write denied by capability+coordinate, exit nonzero
PASS  2b legit work completes, injected read denied by capability+coordinate, exit nonzero
PASS  4 session phext on disk: findings at coordinate, handbook still V1
PASS  3 raised blueprint lets the handbook write through (exit 0, V2 on disk)
PASS  5 audit holds no scroll text; denied decisions name capability+coordinate
PASS  all Stage-1 checks passed.        (exit 0)
```

Key observed outputs: work.ts →
`[result] toc=4 handbook-first-words=HANDBOOK-TRIAGE-V1 Support triage findings-at=1.1.1/1.2.1/1.1.2 readback=ok`.
Injected write denial →
`policy denied phext.example/scrolls.write with coordinate = "1.1.1/1.1.1/1.1.1", lane = "1.1.1/1.1.1", length = 65, phextId = "demo" for main`.
Injected read denial → same shape for `scrolls.select` at
`1.1.1/1.3.1/1.1.1`. Audit: 0 occurrences of `HANDBOOK-TRIAGE-V1` and of
`OTHER-SESSION-NOTES`; denied `decision` records present for both
capabilities with the coordinates in `context.payload_json`.

## Deviations from PLAN.md (all evidenced, none hidden)

1. **Engine: mid-file insertion added.** The spike engine's upsert was
   append-only, but the plan's own fixture lane order puts the session
   lane (`1.2.1`) *before* the other-session lane (`1.3.1`), so the
   findings write at `1.1.1/1.2.1/1.1.2` is an insertion between existing
   entries. Stage-1 `upsertScroll` now inserts at the sorted position and
   re-derives the delimiter chain (`rebuildDelimiters`), creating empty
   intermediates as the byte format implies. Untouched entries keep
   their original delimiters (consecutive parsed entries differ by
   exactly one step, so the walk reproduces them); new package tests
   assert toc order, contents, and a byte-exact re-parse of the file
   after a mid-insert.
2. **Blueprint: one more package rule than PLAN §5 — `fs.stat` with
   `path == "/phext"`.** The package's `ensureDir()` stats its own
   directory; `path glob "/phext/*"` does not match `/phext` itself.
   Stage 0's lint had shown this require as a *warning* and the spike
   never executed under §5 on a server, so the gap only appeared in
   Stage 1's first server run, where every op was denied at `ensureDir`.
   The rule matches the build's derived require exactly; both blueprints
   carry it, commented in place. (Same class of gap as Stage 0's
   `fs.mkdir` amendment.)
3. **app.mjs grew a session mode** (task-sanctioned), and with it a
   v0.5.1 quirk fix: the session execute response carries `console: []`;
   console lines live on `GET /v1/sessions/{id}/last-run`. Session mode
   fetches last-run for the `[program]` lines. Without this, test 2's
   "legitimate work completes and prints" has no evidence.
4. **Two injected programs instead of PLAN §6's single combined one**
   (per task): a denial aborts the run, so one program cannot exhibit
   both denials. Whether `check()` denials are catchable in the subset
   was not investigated; the two-program shape is kept regardless.
5. **Test 3 uses a fresh session** under the raised blueprint instead of
   re-using session A: blueprint apply replaces by name server-wide, and
   a fresh seed keeps test 4's "handbook still V1" assertion about the
   non-raised run clean. The original blueprint is re-applied at the end
   of verify.sh. (Observed: re-applying a blueprint does not disturb an
   open session — the experiment's session A kept working across an
   apply.)
6. **verify.sh regenerates the fixture** via `make_fixture.py` at the
   start of each run (deterministic — same SHA-256 every run) rather
   than trusting the committed bytes.

## Left unverified / out of scope

- **Stage 2 (act 6, persistence)** — named volume, restart, new session:
  not built; Stage-1 scope was acts 1–5.
- **One-off mode** of app.mjs was smoke-tested only (a `toc` on an empty
  phext returned 0 with console intact during experiments); the demo
  flow and all tests use session mode.
- **Audit durability:** audit assertions ran after `submilli server
  stop`, so records are known to survive a clean stop; mid-run flush
  timing was not characterised (records were visible in the experiment
  log while the server was up, but verify.sh does not rely on that).
- Nothing was pushed to GitHub; no model keys were used; all state was
  user-local (stage1 tree + `~/.local/bin` binaries from Stage 0).

---

# Stage 2 Addendum — Persistence (Act 6)

**Date:** 2026-11-01 · **Scope:** PLAN.md §8 Stage 2 — named volume,
server restart, new session (test 6). **Verdict: PASS** — the full
verify.sh suite (tests 1–6) ran twice after the change, exit 0 both
times; tests 1–5 output is byte-for-byte the Stage-1 shape.

## What was added / changed

| Path | Change |
|---|---|
| `blueprint-persistent.yaml` | **New.** Name `phext-demo-persistent`; variables and every `main` + package permission rule identical to `blueprint.yaml`. Only the storage differs (below). Lints exit 0 without `--deny-warnings` (3 benign narrower-grant warnings). |
| `programs/readback.ts` | **New.** Session-B program: `readScroll` the findings coordinate `1.1.1/1.2.1/1.1.2` + `checksum("demo")`, returns `findings=<text> checksum=<hex>`. Read-only. |
| `app.mjs` | Minimal addition: a `--blueprint NAME` flag (any position, default `phext-demo`) so sessions can be opened under `phext-demo-persistent`. All Stage-1 behaviour unchanged; the flag is used only by the test-6 flow. |
| `verify.sh` | Server config gains the `volumes:` block; setup lints the third blueprint; **test 6** added after test 5 (start/stop helpers local to it); final banner reworded to "Stage-1 + Stage-2". Tests 1–5 code untouched except the config they run under (an unused volume declaration does not affect them). Test 6 also saves the volume phext to `logs/verify-t6-volume.phext` as evidence. |
| `README.md` | Act 6 walkthrough + how the volume/mount works; limits list now covers both Blueprints' lifetimes; layout updated. |

## Volume mechanics (exact syntax, with sources)

Server config — the volume is an **operator** declaration
(`docs/part-6-reference/server-settings.md`, "`volumes`": each entry
maps a name to `kind` (required), `path` (local-path only), `access`,
and `size_limit` (**required**, e.g. `1GB`); `managed-local` keeps files
at `<volume_dir>/managed-local/<name>`):

```yaml
volumes:
  phext-memory:
    kind: managed-local
    size_limit: 1GB
```

Blueprint — the mount form (`docs/part-6-reference/blueprint-file.md`,
"vfs" / "Mounts": `mounts` maps an absolute guest path to
`{ mode: named, volume, subPath?, access? }`; at most 16 mounts, no
nesting; access can only narrow the server's declaration):

```yaml
vfs:
  mode: per_session
  mounts:
    /phext:
      mode: named
      volume: phext-memory
      access: read_write
```

The mount makes the volume's root the guest's `/phext` (no `subPath`),
so the Package's `/phext/demo.phext` is exactly
`$SUBMILLI_HOME/server/volumes/managed-local/phext-memory/demo.phext`
on the host. **No Package code and no permission rule changed** — guest
paths are identical under both Blueprints, which is the design point:
the fs confinement rules never learn where the bytes live.

## Empirical findings (rehearsed standalone first, then in verify.sh)

1. **The volume directory pre-exists any session.** At server startup
   the volume root's `managed-local/` is created (server-settings.md,
   "Directories"), and `managed-local/phext-memory/` was present in the
   tree immediately after boot, before any blueprint apply or session.
   Seeding is therefore an operator host copy *before session A opens*:
   `cp fixture/demo.phext …/managed-local/phext-memory/demo.phext`.
   (Contrast Stage 1's per-session seeding, which must wait for the
   session to exist.)
2. **Blueprints survive a restart.** After `submilli server stop` and a
   fresh boot on the same home, `submilli server blueprint list` still
   shows `phext-demo-persistent` — test 6 checks this and only re-applies
   if the name is absent (it was present in every run).
3. **Writes land in the volume file, deterministically.** Session A's
   `work.ts` moved the volume phext from the fixture hash `7abb8e51…`
   to `5928f392aedf46b5eea42bf43711f359ae8a892c642e0b3d27720cd650e05928`
   — the same value in the standalone rehearsal and in both verify.sh
   runs (the content is fully deterministic).
4. **Read-only means read-only.** Session B (fresh id, post-restart)
   ran only `readback.ts`; the volume file's SHA-256 afterwards still
   equalled H1, and B's reported `checksum` equalled H1 as well.

## Test 6 — verbatim results (verify.sh run 1)

```
# test 6: persistence across a server restart (named volume at /phext)
persistent session A: bce1d7f5-1886-47db-a4a0-6dce3f078484 (volume seeded by host copy before the session opened)
volume phext after session A: sha256=5928f392aedf46b5eea42bf43711f359ae8a892c642e0b3d27720cd650e05928
blueprint 'phext-demo-persistent' survived the restart; no re-apply needed
persistent session B: 5e6c2821-fb66-4814-b62c-610203aebe48 (fresh session id, opened after the restart)
PASS  6 persistence: new session after server restart reads prior session's scroll; checksum matches disk
```

Session B's actual result line (`logs/verify-t6b.log`):

```
[result]  findings=Findings after reviewing the triage handbook at 1.1.1/1.1.1/1.1.1: the protocol has three steps - identify the customer and the failing service, check recent changes before escalating, then record findings in the session lane. checksum=5928f392aedf46b5eea42bf43711f359ae8a892c642e0b3d27720cd650e05928
```

Full suite tail (both runs identical, exit 0):

```
PASS  1 legit program exits 0 with the expected summary
PASS  2a legit work completes, injected write denied by capability+coordinate, exit nonzero
PASS  2b legit work completes, injected read denied by capability+coordinate, exit nonzero
PASS  4 session phext on disk: findings at coordinate, handbook still V1
PASS  3 raised blueprint lets the handbook write through (exit 0, V2 on disk)
PASS  5 audit holds no scroll text; denied decisions name capability+coordinate
PASS  6 persistence: new session after server restart reads prior session's scroll; checksum matches disk
PASS  all Stage-1 + Stage-2 checks passed.
```

## Deviations / notes

- **No deviation from the task's preferred design was needed.** The
  `per_session` root + `/phext` mount shape worked as specified; the
  `vfs: named`-as-root fallback was not required.
- One rehearsal mishap, outside the deliverable: a detached rehearsal
  server briefly outlived its scratch home because a stop command ran
  without `SUBMILLI_SERVER_URL` in its shell; it was found by pid and
  killed, and `pgrep` confirms no `submilli-server` remains after the
  final verify.sh runs (verify.sh itself manages its server in one
  shell and was unaffected).
- `blueprint-persistent.yaml` lints with 3 benign warnings, not 4: the
  exact `fs.stat path == "/phext"` rule now matches one derived require
  precisely. Same designed narrowness as Stage 1.
- Unverified / out of scope: concurrent-writer behaviour on the shared
  volume (documented last-write-wins caveat stands); `local-path`
  volumes (only `managed-local` exercised); session A's own survival
  across the restart (the demo deliberately uses a *new* session B —
  server-side, session lifecycle records are documented to survive, but
  Act 6 does not depend on it).
- Nothing was pushed to GitHub; publishing remains a separate step.

---

# Addendum — Route A: SQ over HTTP (`../routea/`)

Built 2026-11-01 at Will's direction ("implement Route A"), as a
variant alongside Route B — Route B's tree is untouched except the
README/BUILD-REPORT addenda; `verify.sh` was re-run after the Route A
work and tests 1–6 still PASS (see "Regression" below).

## Design

Same package (`@wbic16/phext`), same four operations, same capability
names and per-op `check()` payloads as Route B. Only the backend in
`src/lib.ts` changed: SQ HTTP calls instead of fs. Governing
invariant (Will): *the runtime has to be the only thing holding the
SQ key — if the key can reach the sandbox, the capability model leaks
and the demo proves nothing.*

- The key exists only in the SQ process (`--key`) and in
  submilli-server's encrypted secret store (operator:
  `submilli server secret put SQ_API_KEY`, server started with
  `SUBMILLI_SECRET_KEY` set). `blueprint-routea.yaml` declares it by
  name only: `secrets: { SQ_API_KEY: { store: SQ_API_KEY } }`.
- The package fetches the key per call via `secrets.get` and sets
  `Authorization: "Bearer " + key` itself (curated github/brave
  pattern). The key is never in a `check()` payload, never returned,
  never logged.
- `src/config.ts` carries only `sqBaseUrl` (set via `--config` at
  build/publish time) — inspectable configuration, not a secret. All
  build commands with `--config` need explicit `-p @wbic16/phext`.
- Package caller list: `http.get`/`http.post`, each as
  `host == "127.0.0.1" and path glob "/api/v2/*"` plus the
  port-carrying variant `host glob "127.0.0.1:*" and path glob
  "/api/v2/*"`, and `secrets.get` with `name == "SQ_API_KEY"`. **No
  fs rules.** `main`: byte-identical to Route B's main section
  (verified by extraction + diff, test A0) — no http, no secrets.
- The compiled artifact's `capabilities.yaml` requires exactly
  `http.get` (filter `host == "127.0.0.1"`), `http.post` (same),
  `secrets.get` (filter `name == "SQ_API_KEY"`) — derivation
  normalizes the URL to host-only, so the package's own requires are
  *looser* than the blueprint's path-prefixed grants by design; the
  blueprint is the operative constraint. `src/lib.ts` needed no fs
  dead code: the engine (`phext.ts`) is reused purely for
  coordinate/lane math and parsing HTTP-fetched bytes.
- Server side: throwaway home, config sets `network.allow_localhost:
  true` (SQ is on loopback) and the per-run audit file; blueprint sets
  `allow_insecure_http: true` (SQ is plain HTTP on loopback).
  Durable execution off (default), as Route B.

## Endpoint mapping (per op)

| Package op | SQ call | Notes |
|---|---|---|
| `toc` (`toc.read`) | `GET /api/v2/get?p=<id>` | whole raw phext, parsed in-package; SQ's own `toc` would do, but the parse also backs the missing-scroll disambiguation below |
| `readScroll` (`scrolls.select`) | `GET /api/v2/select?p=<id>&c=<coord>` | empty body → re-check via `/get`+parse to distinguish "missing scroll" (throws, matching Route B) from "empty scroll" (returns "") |
| `writeScroll` (`scrolls.write`) | `POST /api/v2/update?p=<id>&c=<coord>`, raw body | whole-scroll overwrite, idempotent — Route B's insert-or-replace semantics exactly |
| `checksum` (`checksum.read`) | `GET /api/v2/get?p=<id>` | SHA-256 (`submilli:crypto`) over the exact bytes |

Deliberately **not** used: `/api/v2/json-export` — found lossy for
tabs/backslashes in the ocbox work (§2 of its spec); `/get` returns
the raw `.phext` file. Fidelity caveat: `submilli:http` decodes
bodies as UTF-8; phext's nine delimiter bytes are all single-byte
UTF-8 control codes, so valid-UTF-8 phexts (the fixture included)
round-trip byte-exact. Invalid-UTF-8 scroll bytes would be lossy —
SQ v0.6.0 has no raw-bytes download endpoint.

## Deviations / findings during the build

- **URLs must be built inline at the call site.** Extracting a
  `sqUrl(path)` helper made Submilli's host derivation fail
  ("context field url.host unresolved", plus a `--deny-warnings`
  failure) — derivation follows the config constant through
  concatenations written at the `get`/`post` call itself.
- **The stdlib `Response` type is not nameable**, and passing a
  response through a hand-declared lookalike interface traps at
  runtime with a cast failure (the subset checks casts at function
  boundaries). Fixed brave-style: `.ok` checked inline at each call
  site. Both rehearsal finds, now commented in `src/lib.ts`.
- **Package unit tests cover the engine only** (4 tests: delimiter
  parse, byte-exact round-trip + SHA-256, lane boundaries,
  mid-insert/reparse). The four ops need a live SQ, so they are
  exercised by `verify-routea.sh` instead — a build test has no
  server.
- `blueprint-routea-permissive.yaml` exists only for probe A3a: it
  adds a main `secrets.get` rule. The linter itself warns the rule
  "has no effect — secret values are never available to main-module
  code", and the run confirms it.
- Lint of both blueprints: valid, with the benign "grants it
  differently" warnings (the path-prefixed grants are narrower than
  the derived host-only requires) — same character as Route B's
  designed-narrowness warnings; linted without `--deny-warnings`.

## Verify results (`../routea/verify-routea.sh`, run twice, both green)

```
PASS  A0 main permissions byte-identical to Route B blueprint
PASS  A1 legit program exits 0 with the exact Route B summary
PASS  A2a legit work completes, injected write denied by capability+coordinate, exit nonzero
PASS  A2b legit work completes, injected read denied by capability+coordinate, exit nonzero
PASS  A3b main holds no http rules: direct SQ call denied by policy, no content returned
PASS  A3a secrets.get from main refused by runtime invariant, even under a granting blueprint
PASS  A3c SQ requires the key: 401 without, 401 with a wrong one, 200 with the runtime's
PASS  A4 operator-side SQ select shows findings; SQ's file changed and parses as expected
PASS  A5 audit holds no scroll text and no key; denied decisions name capability+coordinate
PASS  A3d sentinel sweep: SQ key present in zero files (trees, homes, logs, audit, SQ data, outputs)
PASS  all Route A checks passed.
```

A1 result string, verbatim (identical to Route B):
`toc=4 handbook-first-words=HANDBOOK-TRIAGE-V1 Support triage findings-at=1.1.1/1.2.1/1.1.2 readback=ok`

A3a refusal, verbatim (under the permissive blueprint):

> PermissionDeniedError: permission denied: caller=main capability=secrets.get: secret values are never available to main-module code, and no policy can grant this. The package that needs this credential resolves it internally and never returns it — pass the secret NAME to that package's API instead. Do not work around this denial: not through another package, not by asking a package to fetch the value and hand it back, not through raw HTTP. Report it and stop.

A3d sweep scope: `routea/` and `stage1/` trees (including captured
program outputs in `logs/`), the throwaway `SUBMILLI_HOME` (encrypted
secret store + compiled package artifact included), server log, audit
file, SQ log and SQ data dir — the per-run sentinel appeared in zero
files. (Process argument lists are outside file scope by definition;
the throwaway servers are killed at exit.)

A4 note: SQ's post-work `demo.phext` SHA-256 is
`5928f392aedf46b5eea42bf43711f359ae8a892c642e0b3d27720cd650e05928` —
byte-identical to Route B's Stage-2 in-runtime checksum over the
named-volume file. Two storage backends, same writes, same bytes.

## Regression

`stage1/verify.sh` re-run after all Route A work: tests 1–6 PASS,
unchanged (Route B untouched apart from these addenda).
