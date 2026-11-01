# Submilli × Phext — Demo (Route B, Stages 1–2)

An agent's working memory as a **phext**: one file of coordinate-addressed
scrolls, held inside a [Submilli](https://github.com/submilli/submilli-runtime)
session and reachable only through a Package whose every operation is
checked against a Blueprint. The agent may read a shared handbook lane and
write its own session lane. When a prompt-injected ticket tells it to
"correct" the handbook or "reconcile" another session's notes, the runtime
— not the model, not the prompt — refuses, by capability and coordinate.
And the memory can outlive the session: on an operator-declared named
volume, the same phext survives a server restart and is read back by a
brand-new session (Act 6).

## Architecture

One TypeScript Package, `@wbic16/phext`, carries a small phext engine
(ported from the Python dead-reckoning parser) and exposes four operations
— `toc`, `readScroll`, `writeScroll`, `checksum` — each declaring a
granular capability (`phext.example/scrolls.select`, …) and calling
`check()` with `{ phextId, coordinate, lane }` (plus `length` for writes;
**never scroll contents**, because check payloads land in Submilli's audit
log). The engine stores one phext per identifier at `/phext/<id>.phext`
in the session filesystem, using `submilli:fs` byte APIs only. The
Blueprint binds `phextId` and the writable `lane` as session variables
(the trusted application sets them; the program cannot), grants reads in
the reference lane and read/write in the session lane, and everything
else is default-denied. Two layers of confinement stack: the Blueprint's
`fs.*` rules confine the *Package* to `/phext/*`, and the Package's
phext rules confine the *program* to coordinates inside the file.

```
app.mjs ──binds {phextId: demo, lane: 1.1.1/1.2.1}──► submilli-server
   │                                                      │ runs program
   └──── host copy: fixture/demo.phext ──► per-session dir ┘
                                          └─► @wbic16/phext ──check()──► Blueprint rules
                                                  │
                                                  └─► /phext/demo.phext (the memory)
```

## The fixture

`fixture/demo.phext` (517 bytes, SHA-256
`7abb8e5123b7082d202d9a45365ef08507cae570a6dfb84896d232c13488d831`,
regenerate/verify with `python3 fixture/make_fixture.py`) holds four
scrolls in three lanes:

| Coordinate | Lane | Content |
|---|---|---|
| `1.1.1/1.1.1/1.1.1` | reference (read-only) | support triage handbook (`HANDBOOK-TRIAGE-V1`) |
| `1.1.1/1.1.1/1.1.2` | reference (read-only) | escalation notes |
| `1.1.1/1.2.1/1.1.1` | **session (writable)** | "Session opened. No findings yet." |
| `1.1.1/1.3.1/1.1.1` | another session's (no access) | `OTHER-SESSION-NOTES` |

## Prerequisites

- Submilli **pinned v0.5.1**: `curl -fsSL https://submilli.ai/install.sh | sh -s -- --version v0.5.1` (installs `submilli` + `submilli-server` into `~/.local/bin`)
- Node.js 22+, `python3`, `openssl`, `curl`
- No model API keys — the demo programs are fixed files, like the
  quickstart's.

## Run it

Everything in one shot: `./verify.sh` — it builds, seeds, runs all six
checks below, prints PASS/FAIL per check, and cleans up. Logs in `logs/`.

Act by act, by hand:

```sh
export PATH="$HOME/.local/bin:$PATH"
export SUBMILLI_HOME="$PWD/.submilli-home"

# Act 1 — setup: fixture, package, blueprints
python3 fixture/make_fixture.py
submilli build check --deny-warnings
submilli build test --deny-warnings
submilli build publish-local
submilli blueprint lint blueprint.yaml          # 4 benign warnings expected:
submilli blueprint lint blueprint-raised.yaml   # grants are narrower than derived requires, by design

export SUBMILLI_BIND=127.0.0.1 SUBMILLI_PORT=8128
export SUBMILLI_SERVER_URL="http://127.0.0.1:8128"
export SUBMILLI_SERVER_TOKEN="$(openssl rand -hex 32)"
submilli-server & submilli-server --health-check
submilli server blueprint apply blueprint.yaml

# Seed: open a session, host-copy the fixture into its per-session dir
SID="$(node app.mjs --open-session | sed -n 's/^\[session\] //p')"
mkdir -p "$SUBMILLI_HOME/server/volumes/sessions/$SID/phext"
cp fixture/demo.phext "$SUBMILLI_HOME/server/volumes/sessions/$SID/phext/demo.phext"

# Act 2 — legitimate work
node app.mjs --session "$SID" programs/work.ts
# [result]  toc=4 handbook-first-words=HANDBOOK-TRIAGE-V1 Support triage findings-at=1.1.1/1.2.1/1.1.2 readback=ok

# Act 3 — proof outside the runtime: the file on disk is the memory
cp "$SUBMILLI_HOME/server/volumes/sessions/$SID/phext/demo.phext" /tmp/after.phext
python3 -c "
import importlib.util, pathlib
s = importlib.util.spec_from_file_location('p', pathlib.Path.home()/'workspace/phext/parse_phext.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
[print(c, '|', t[:60]) for c, t in m.parse('/tmp/after.phext')]"

# Act 4 — injection: both attempts are denied, exit 1, after the
# legitimate steps complete and print
node app.mjs --session "$SID" programs/work-injected-write.ts
node app.mjs --session "$SID" programs/work-injected-read.ts

# Act 5 — the raise: one added Blueprint rule, the write goes through
submilli server blueprint apply blueprint-raised.yaml
SID2="$(node app.mjs --open-session | sed -n 's/^\[session\] //p')"
mkdir -p "$SUBMILLI_HOME/server/volumes/sessions/$SID2/phext"
cp fixture/demo.phext "$SUBMILLI_HOME/server/volumes/sessions/$SID2/phext/demo.phext"
node app.mjs --session "$SID2" programs/write-handbook.ts
submilli server blueprint apply blueprint.yaml   # revert the raise

# Act 6 — persistence: the same phext on a named volume outlives the
# session and the server. The volume is the OPERATOR's declaration in
# the server config (not the Blueprint's):
mkdir -p .submilli-home && cat > /tmp/server-persistent.yaml <<'EOF'
volumes:
  phext-memory:
    kind: managed-local      # files at $SUBMILLI_HOME/server/volumes/managed-local/phext-memory/
    size_limit: 1GB          # required; one limit covers all sessions/blueprints
EOF
SUBMILLI_CONFIG=/tmp/server-persistent.yaml submilli-server & submilli-server --health-check
submilli server blueprint apply blueprint-persistent.yaml
# The server created managed-local/phext-memory/ at startup, before any
# session exists — seed it directly, once:
cp fixture/demo.phext "$SUBMILLI_HOME/server/volumes/managed-local/phext-memory/demo.phext"
SIDA="$(node app.mjs --blueprint phext-demo-persistent --open-session | sed -n 's/^\[session\] //p')"
node app.mjs --session "$SIDA" programs/work.ts        # session A writes its findings
sha256sum "$SUBMILLI_HOME/server/volumes/managed-local/phext-memory/demo.phext"
submilli server stop                                   # ← the server dies here
SUBMILLI_CONFIG=/tmp/server-persistent.yaml submilli-server & submilli-server --health-check
SIDB="$(node app.mjs --blueprint phext-demo-persistent --open-session | sed -n 's/^\[session\] //p')"
node app.mjs --session "$SIDB" programs/readback.ts
# [result]  findings=Findings after reviewing the triage handbook … checksum=<same sha256 as above>
submilli server stop
```

How Act 6 works: `blueprint-persistent.yaml` is `blueprint.yaml` with
one change — its `vfs` keeps the `per_session` root but grafts the named
volume at guest path `/phext` (`mounts: { /phext: { mode: named, volume:
phext-memory } }`). The volume's root directory *is* the guest's
`/phext`, so the Package's `/phext/demo.phext` lands at
`managed-local/phext-memory/demo.phext` on the host — no Package or
permission change at all (guest paths are identical; the fs rules in
§3/§5 never learn where the bytes live). Blueprints themselves are
registered in the server's own store and also survive the restart;
session B is a fresh session that never saw session A's per-session
directory, and still reads A's findings, with a checksum that matches
the file on disk byte for byte.

## Layout

```
submilli.toml            package project manifest (@wbic16/phext)
package/src/lib.ts       the four operations (capabilities + check())
package/src/phext.ts     the phext engine (parse / serialise / upsert)
package/tests/           build tests: round-trip, ops, lane boundaries, mid-file insert
package/docs/readme.md   model-facing package documentation
fixture/                 make_fixture.py + demo.phext
blueprint.yaml           the demo Blueprint (default deny, one write rule)
blueprint-raised.yaml    same + the one-line raise for the reference lane
blueprint-persistent.yaml  same rules; per_session root + phext-memory volume mounted at /phext
app.mjs                  the application (binds phextId/lane; one-off + session modes, --blueprint)
programs/                work.ts, work-injected-write.ts, work-injected-read.ts, write-handbook.ts, readback.ts
verify.sh                the six end-to-end checks
```

## Honest limits

- **Two lifetimes, by Blueprint:** under `blueprint.yaml` the phext
  lives in a `per_session` directory and dies with the session / server
  state. Under `blueprint-persistent.yaml` it lives on the named volume
  and survives sessions and restarts — *because the operator's server
  keeps the volume*: the server never deletes a volume's files, but the
  volume is still just a directory on the operator's disk
  (`managed-local/phext-memory/`), not magic. Delete the server's home
  and the memory is gone like anything else on that disk.
- **Single writer:** nothing serialises two sessions writing the same
  phext — on the shared named volume most of all; a shared file is
  last-write-wins. The demo is single-writer by construction.
- **Whole-file rewrites:** every write re-serialises the whole phext
  (fine at demo scale; the fs whole-read limit is 50 MiB).
- **Whole-scroll writes only:** insert-or-replace at one coordinate; no
  partial edits, no append.
- **Durable execution is off** (Submilli default). Keep it off: an
  uncommitted write could otherwise be replayed after a crash.
- **Version pin:** built and verified against Submilli v0.5.1 only; the
  denial error shape already changed once in the project's history.

## Route A — the SQ-over-HTTP variant (`../routea/`)

Everything above is Route B: the phext lives in the session
filesystem and the package's engine reads/writes it directly. The
sibling directory `../routea/` is the same demo with the storage
backend swapped to an operator-run **SQ** server (`sq host`, SQ
v0.6.0, `/api/v2` HTTP API):

- **Same package name, same four operations, same capability names
  and `check()` payloads.** `toc`/`checksum` read the whole phext via
  SQ's `GET /api/v2/get` (raw file — *not* `json-export`, which the
  ocbox work found lossy for tabs/backslashes); `readScroll` is
  `GET /api/v2/select`; `writeScroll` is `POST /api/v2/update`
  (whole-scroll, idempotent). The engine (`phext.ts`) is reused for
  coordinate/lane math and for parsing HTTP-fetched bytes; the Route A
  artifact's `capabilities.yaml` requires **only** `http.get`,
  `http.post` and `secrets.get` — no `fs.*` anywhere.
- **The program's permissions are byte-identical.** verify-routea.sh
  test A0 extracts the `main` section from both blueprints and diffs:
  no difference. `work.ts` returns the exact Route B summary string,
  and both injected programs are denied with the same shapes (A1/A2).
- **The invariant (Will):** *"when the store becomes HTTP, the
  runtime has to be the only thing holding the SQ key. If the key can
  reach the sandbox, the capability model leaks and the demo proves
  nothing."* The key exists in exactly two places, both
  operator-side: the SQ process (`--key`) and submilli-server's
  encrypted secret store (operator: `submilli server secret put
  SQ_API_KEY`, with a secret-store key configured). The blueprint
  declares the secret **by name only**; the package fetches it per
  call via `secrets.get` and sets the `Authorization` header itself.
  `main` holds no `http.*` rules and no `secrets.get` rule, and
  `src/config.ts` carries only the SQ base URL — inspectable
  configuration, never a credential.
- **Proven by attacking it** (`../routea/verify-routea.sh`, per-run
  sentinel key): A3a — a blueprint that *grants* main `secrets.get`
  is still refused by the runtime ("secret values are never available
  to main-module code, and no policy can grant this"); A3b — a direct
  SQ call from main is denied by policy before it leaves the sandbox;
  A3c — SQ itself returns 401 with no/wrong key and 200 with the
  runtime's key; A3d — a sentinel sweep over both trees, the server
  home, all logs, the audit file, SQ's data dir and every program
  output finds the key in **zero files**; A5 — the audit file holds
  the denied capability+coordinate records and no scroll text, no key.
  A side observation: SQ's post-work phext file is byte-identical to
  Route B's Stage-2 result (SHA-256 `5928f392…`) — the two backends
  serialize the same writes to the same bytes.

Honest notes for Route A: loopback HTTP is a **local-demo posture** —
production wants SQ behind HTTPS (then only `sqBaseUrl` changes) or
the server's egress grants re-checked for wherever SQ lives. Writes
are whole-scroll overwrites via SQ `update`, so a replayed write is
idempotent; durable execution stays **off** regardless, as in Route B.
`submilli:http` decodes bodies as UTF-8, and that is exact for
phext: a phext is valid UTF-8 within each scroll — scroll content
is text, the delimiter bytes are ASCII control codes (themselves
valid UTF-8), and arbitrary binary rides inside scrolls as text
(e.g. base64) — so phexts round-trip byte-exact over this
transport.
