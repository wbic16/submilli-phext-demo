# Route A — SQ over HTTP (variant of the Route B demo)

The same demo as `../stage1/`, with the storage backend swapped: the
phext no longer lives in the session filesystem — it lives in an
operator-run **SQ** server (`sq host`, SQ v0.6.0, `/api/v2`), and the
`@wbic16/phext` package reaches it over HTTP.

Everything the generated program can do is unchanged — test A0 of
`verify-routea.sh` proves the `main` permission section of
`blueprint-routea.yaml` is **byte-identical** to Route B's
`../stage1/blueprint.yaml`, and `work.ts` returns the identical
summary string. Only the package's backend and its own caller-list
rules changed.

## The invariant (the reason this variant exists)

> When the store becomes HTTP, the runtime has to be the only thing
> holding the SQ key. If the key can reach the sandbox, the capability
> model leaks and the demo proves nothing.

Concretely, the key exists in **exactly two places**, both
operator-side and outside the agent system:

1. the SQ process itself (`sq host <port> --key <key>`);
2. submilli-server's **encrypted secret store** — the operator runs
   the server with a secret-store key configured and does
   `submilli server secret put SQ_API_KEY`.

The Blueprint declares the secret **by name only**
(`secrets: { SQ_API_KEY: { store: SQ_API_KEY } }`). The package
fetches it per call via `secrets.get` and sets the `Authorization`
header itself — the curated github/brave pattern. The key never
appears in any blueprint, `app.mjs`, any program, the package source,
its compiled artifact, `capabilities.yaml` (which requires only
`http.get`/`http.post` + `secrets.get` — no `fs.*` anywhere), the
audit log, any program output, or the phext. `src/config.ts` carries
**only** the SQ base URL, which is inspectable configuration by
design — never a credential. And `main` holds no `http.*` rules and
no `secrets.get` rule: it has no path to SQ except through the
package's four checked operations.

## Prove it: `./verify-routea.sh`

Throwaway SQ + throwaway submilli-server, random ports, a per-run
sentinel as the SQ key. PASS/FAIL per test, logs in `logs/`:

- **A0** — `main` sections byte-identical between the two blueprints.
- **A1** — legit work, exact Route B summary string.
- **A2** — both injected programs denied, same shapes as Route B.
- **A3a** — `programs/probe-secrets.ts` under
  `blueprint-routea-permissive.yaml` (which *grants* main
  `secrets.get`): the runtime refuses anyway — *"secret values are
  never available to main-module code, and no policy can grant
  this."*
- **A3b** — `programs/probe-http.ts` calls SQ directly from main:
  denied by policy (`http.get` for main), nothing returns.
- **A3c** — SQ itself: no key → 401, wrong key → 401, the runtime's
  key → 200. The key is load-bearing, not theatre.
- **A3d** — after all runs, a grep for the sentinel across both demo
  trees, the throwaway server home (including the encrypted store and
  the compiled artifact), all logs, the audit file, SQ's data dir and
  every captured program output: **zero files**.
- **A4** — operator-side SQ `select` (with the key) shows the
  findings scroll; SQ's phext file changed on disk and the Python
  parser agrees. Curiosity that fell out: the post-work file's
  SHA-256 (`5928f392…`) is byte-identical to Route B's Stage-2 result
  — SQ's serializer and the in-package engine produce the same file
  for the same writes.
- **A5** — audit file: denied decisions name capability+coordinate;
  no scroll text, no key.

## Files

```
submilli.toml              the @wbic16/phext project (Route A build)
package/                   src/lib.ts (SQ backend), src/phext.ts (engine,
                           reused for coordinate/lane math + parsing),
                           src/config.ts (sqBaseUrl — the only config),
                           tests (pure-engine only; ops are covered by
                           verify-routea.sh, a build test has no SQ)
blueprint-routea.yaml      the Route A blueprint (main == Route B, byte for byte)
blueprint-routea-permissive.yaml  probe-only: grants main secrets.get, to be refused
app.mjs                    copied from ../stage1 (binds phextId/lane; --blueprint)
programs/                  work.ts, work-injected-*.ts, write-handbook.ts,
                           readback.ts (all copied unchanged), plus
                           probe-secrets.ts and probe-http.ts.tmpl
fixture/                   the same demo.phext (regenerated deterministically)
verify-routea.sh           tests A0–A5 above
logs/                      per-test logs from the latest verify run
```

## Honest notes

- **Loopback HTTP is a local-demo posture.** SQ speaks plain HTTP;
  the blueprint sets `allow_insecure_http: true` and the server sets
  `network.allow_localhost: true`. Production wants SQ behind an
  HTTPS reverse proxy (or a re-check of the server egress grants for
  wherever SQ actually lives), at which point `sqBaseUrl` changes and
  nothing else does.
- **Duplicate-write semantics:** `writeScroll` is SQ `update` —
  whole-scroll overwrite, so a replayed write lands identical bytes
  (idempotent). Durable execution stays **off** regardless (Submilli
  default); with it on, uncommitted external effects may re-execute.
- **Fidelity:** `toc`/`checksum` read the whole phext through SQ's
  `/get` (raw file), *not* `json-export` (found lossy for
  tabs/backslashes in the ocbox work). `submilli:http` decodes bodies
  as UTF-8; phext delimiters are single-byte UTF-8 control codes, so
  valid-UTF-8 phexts round-trip byte-exact. A phext with invalid-UTF-8
  scroll bytes would be lossy here — SQ v0.6.0 offers no raw-bytes
  download.
- **SQ's ghost-file behaviour:** naming a new `p` in SQ silently
  creates an empty phext. The package always uses the bound phextId,
  and the demo's phext is seeded by the operator, so this never fires
  in the demo flow — noted for production use.
