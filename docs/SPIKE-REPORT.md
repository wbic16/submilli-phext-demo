# Stage 0 Spike Report — Submilli × Phext (Route B)

**Date:** 2026-11-01 · **Workdir:** `~/workspace/submilli-phext/stage0/` ·
**Raw logs:** `stage0/logs/` · **Pinned release:** v0.5.1 throughout.

| Spike | Verdict |
|---|---|
| 1 — Install pinned v0.5.1 + their quickstart verify.sh | ✅ **PASS** |
| 2 — TS-subset phext port + byte-exact SHA-256 round-trip | ✅ **PASS** (with one documented fs quirk, worked around in-package) |
| 3 — Blueprint lint of PLAN §5, `"${vars.lane}/*"` glob | ✅ **PASS for the glob form** — lint-clean once one missing package rule (`fs.mkdir`) is added; the `laneGlob` fallback is NOT needed. PLAN §5 needs that one-rule amendment (see §3.3) |

**Overall gate: Stage 1 unblocked** — with two PLAN amendments carried
forward: (a) add the `fs.mkdir` rule to the Package's caller list in §5;
(b) `blueprint lint --deny-warnings` stays red on 4 benign warnings
(§3.3) — Stage 1 should lint the Blueprint without `--deny-warnings`,
or accept the warnings explicitly. Neither touches the demo design.

---

## Spike 1 — Install + their verify — ✅ PASS

Installer usage checked first in the clone's `install.sh`:
`Usage: sh install.sh [--version TAG] [--install-dir DIR]`
(line 2). Installed user-local only, no sudo:

```sh
curl -fsSL https://submilli.ai/install.sh | sh -s -- --version v0.5.1
# -> Installed submilli and submilli-server v0.5.1 to /home/hatch/.local/bin
submilli --version        # submilli 0.5.1
submilli-server --version # submilli-server 0.5.1
```
(logs: `logs/install.log`, `logs/version-cli.txt`, `logs/version-server.txt`)

Verify, reusing the existing shallow clone at
`/tmp/submilli-recon/submilli-runtime` (HEAD `aeaded7`, still present):

```sh
cd /tmp/submilli-recon/submilli-runtime/examples/quickstart
PATH="$HOME/.local/bin:$PATH" SUBMILLI=submilli SUBMILLI_SERVER=submilli-server ./verify.sh
# exit=0
```
Final line of `logs/verify.log`:
```
PASS  the total came back, and the injected call was denied.
```
Both required outcomes asserted by their harness itself: the legit
program returns `[result] 2 charges, 6150 cents`, and the injected
program completes its legit work, then is denied on
`pied-piper.example/charges.list` with `customerId = "hooli"` — plus
their control cases (unfiltered blueprint allows it, flipped binding
inverts it, role split, missing variable, bad token). No model keys used.

## Spike 2 — TS-subset phext port — ✅ PASS

Scaffold: `submilli build init @wbic16/phext package` in `stage0/spike/`
(logs/init.log). Package layout per PLAN §3: engine in
`package/src/phext.ts`, ops in `package/src/lib.ts`
(`toc`, `readScroll`, `writeScroll`, `checksum` — each a JSDoc
`@capability` tag + `check()` before the effect), tests in
`package/tests/lib.test.ts`.

Engine: a direct port of the byte-walk in
`~/workspace/phext/parse_phext.py` — delimiters
`0x01, 0x1F, 0x1E, 0x1D, 0x1C, 0x1A, 0x19, 0x18, 0x17`
(Library→Scroll); hitting one increments that level and resets lower
levels to 1. Parse records the delimiter preceding each entry, so
serialise reproduces the input byte-for-byte. All phext file I/O uses
`submilli:fs` **byte APIs** (`read`/`write`); `readText`/`writeText`
are never used for phext content.

Final runs (logs/build-check.log, logs/build-test.log):
```sh
submilli build check --deny-warnings   # exit 0 — "checked @wbic16/phext v0.1.0"
submilli build test  --deny-warnings   # exit 0
```
```
ok   package/tests/lib.test.ts :: engine parses all nine delimiter classes to the expected coordinates
ok   package/tests/lib.test.ts :: engine round-trips byte-exact, sha256 equal
ok   package/tests/lib.test.ts :: fs byte APIs preserve a phext file byte-exact
ok   package/tests/lib.test.ts :: package ops write and read scrolls by coordinate
4 passed, 0 failed across 1 files
```

Test substance (all in `package/tests/lib.test.ts`):
- A 64-byte fixture built byte-by-byte with scrolls separated by **all
  nine delimiter classes**, plus an interior empty scroll. Parse yields
  exactly the 12 expected coordinates (`1.1.1/1.1.1/1.1.1` …
  `2.1.1/1.1.1/1.1.3`), `laneOf("1.1.1/1.2.1/1.1.1") === "1.1.1/1.2.1"`.
- Round-trip asserted twice: byte equality (`Uint8Array.equals`) **and**
  SHA-256 equality via `submilli:crypto` — `sha256(reserialised).toHex()
  === sha256(fixture).toHex()`. Crypto assertions in tests are feasible;
  no fallback needed.
- The same assertions repeated after a write/read cycle through the fs
  byte APIs (fixture written to `/fixture.phext`, read back, re-parsed,
  re-serialised).
- End-to-end ops: `writeScroll` at `1.1.1/1.1.1/1.1.1` and (via the
  append-walk) at `1.1.1/1.2.1/1.1.1`, `readScroll` back, `toc` order,
  and `checksum("demo")` === SHA-256 of the file bytes on disk.

**Cross-check against ground truth:** the identical fixture bytes run
through the Python parser produce the same 12 coordinates
(`logs/python-crosscheck.log`: `MATCH 12 scrolls`; fixture SHA-256
`c52fd01f07df65d861a45821bbeab8e8710cc93d92fa061b8ef7449b34fa34f4`,
64 bytes — matching the 64-byte fs write in the test security log).

Derived `package/capabilities.yaml` matches PLAN §3 exactly: provides
`phext.example/toc.read {phextId}`, `scrolls.select {phextId,
coordinate, lane}`, `scrolls.write {phextId, coordinate, lane,
length}`, `checksum.read {phextId}`; requires `fs.mkdir`
(`path == "/phext" and recursive == true`), `fs.read`, `fs.stat`,
`fs.write`. `submilli build publish-local` installs cleanly.

### 2.1 Findings / deviations (all evidenced in logs)

1. **fs `read()` quirk (the one real obstacle).** `read(path)` is typed
   `Uint8Array | undefined`, but for a *missing file in a directory that
   contains no files yet* it **throws** `Error: fs.read /phext/demo.phext:
   parent directory does not exist (create it with mkdir(path, true))` —
   even immediately after a successful `mkdir` in the same call chain
   (security log sequence `fs.stat → fs.mkdir → fs.read → throw`, in
   logs/build-test-ops.log). Directories in the test VFS appear to
   materialise only once a file is written under them; every successful
   read in the spike is of a written file or a root file. **Workaround
   (in the shipped spike code):** the Package guards every load with
   `exists(path)` before `read(...)`. With the guard, all tests pass.
   Stage 1 should keep the guard and treat the d.ts `undefined`
   contract as unreliable for not-yet-materialised directories.
2. **The Package must own its directory.** A `mkdir` issued by the
   *caller* did not make the Package's subsequent read succeed; the
   Package now creates `/phext` itself (`ensureDir()`), which is also
   why `fs.mkdir` appears in its requires — see Spike 3.
3. **Diagnostic test files were used and then removed.** During the
   hunt for (1), three extra test files (debug/probe/ops isolations)
   were added, run (logs/build-test-{debug,probe,probe2,ops}.log), and
   deleted before the final run, so the final package is exactly the
   PLAN shape with a single test file. One diagnostic found a subset
   strictness worth knowing: string `+` boolean is a compile error —
   "`+` not defined for `string` and `boolean` … write
   `String(exists(...))`" (logs/build-test-probe.log, first run).
4. **JSDoc discipline is enforced under `--deny-warnings`:** exported
   helpers with partial JSDoc (missing `@param`/`@returns`) fail
   `build check` (6 warnings-as-errors on first run). Fixed by
   completing the doc comments.
5. libphext-node was not needed: the subset port from parse_phext.py
   compiled as-is (arrays, `Uint8Array.fromArray/alloc/equals/slice`,
   `TextEncoder/TextDecoder`, template-free string concat). No TS-subset
   feature gaps bit. **PLAN §9's main uncertainty is retired.**

## Spike 3 — Blueprint glob lint — ✅ PASS (glob form), one PLAN amendment

Package published locally first
(`SUBMILLI_HOME=stage0/.submilli-home`, logs/publish-local.log), then
the Blueprint from PLAN.md §5 **verbatim** (`stage0/blueprint.yaml`):

```sh
submilli blueprint lint --deny-warnings blueprint.yaml   # exit 1
submilli blueprint lint blueprint.yaml                   # exit 1
```
Exact output (logs/blueprint-lint.log):
```
error: blueprint.yaml: package `@wbic16/phext` requires `fs.mkdir` with filter `path == "/phext" and recursive == true`, but `permissions.@wbic16/phext` has no matching rule
warning: … requires `fs.read`; `permissions.@wbic16/phext` grants it differently, so the package's calls outside those rules are denied
warning: … requires `fs.stat`; … grants it differently …
warning: … requires `fs.stat` with filter `path == "/phext"`; … grants it differently …
warning: … requires `fs.write`; … grants it differently …
```

**What this proves about the spike's actual question:** no error or
warning mentions `${vars.lane}`, `lane`, `phextId`, any coordinate
glob, or any `main` rule. The `"${vars.lane}/*"` form parses and
validates. The failures are entirely in the Package's own fs grants:

- **Hard error — PLAN §5 gap (real):** the Package requires `fs.mkdir`
  (finding 2.1.2) but §5 grants it only `fs.read`/`fs.write`/`fs.stat`.
- **4 warnings — benign by design:** the build derives *unfiltered*
  `fs.read`/`fs.stat`/`fs.write` requirements (the Package computes its
  paths at runtime, so no path filter can be derived), while §5 grants
  them filtered (`path glob "/phext/*"`). The linter notes the grant is
  narrower than the derived requirement — which is precisely the
  confinement the design wants. They only bite under `--deny-warnings`.

Completion variant (`stage0/blueprint-v2.yaml` = verbatim §5 + one
added rule in the Package's caller list,
`{ capability: fs.mkdir, filter: path == "/phext" and recursive == true, action: allow }`,
every `main` rule byte-identical):

```sh
submilli blueprint lint blueprint-v2.yaml   # exit 0
# ✓ blueprint-v2.yaml is valid   (4 benign warnings above remain)
```
(logs/blueprint-lint-v2.log)

Corroboration: `submilli blueprint lint --fix blueprint.yaml`
(logs/blueprint-lint-fix.log, result in `stage0/blueprint-fix.yaml`)
makes exactly the same completion — it adds the `fs.mkdir` rule and
**preserves both `"${vars.lane}/*"` filters verbatim** in `main`
(cosmetic normalisation aside: `vfs:` expanded to `mode: per_session`,
comments/allow_insecure_http dropped).

### 3.3 Verdict & required PLAN amendments

- ✅ The `"${vars.lane}/*"` glob form **lints clean** — variable
  inserted literally, trailing `/*` widens. **The `laneGlob` fallback
  in PLAN §5 is not needed.**
- Amendment A (required): PLAN §5's Package caller list gains the
  `fs.mkdir` rule above (or run `lint --fix` and adopt its output).
- Amendment B (choice for Stage 1): `--deny-warnings` on the Blueprint
  stays red on the 4 benign warnings. Options: lint the Blueprint
  without `--deny-warnings` (exit 0, warnings visible), or widen the
  Package's fs grants to unfiltered (not recommended — it drops the
  `/phext/*` path confinement that PLAN §3 wants). Recommend the former.
  (Package-side `build check/test --deny-warnings` are clean and stay
  mandatory.)

---

## Overall gate

**Stage 1 unblocked.** All three spikes pass on the pinned v0.5.1
binaries in this VM: their own verify harness passes end-to-end; the
phext engine ports to the TS subset with a byte-exact, SHA-256-checked
round-trip through the real fs byte APIs and matches the Python ground
truth coordinate-for-coordinate; and the Blueprint's variable-glob lane
form is accepted by the linter. Carried into Stage 1: the `exists()`
guard before `read()`, Package-owned `/phext` directory, PLAN
amendments A/B above. Nothing was pushed to GitHub; no model keys used;
installs were user-local (`~/.local/bin`) only.
