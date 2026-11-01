# @wbic16/phext — Route A (SQ over HTTP)

Phext scroll storage as a Submilli Package, backed by an operator-run
SQ server (`sq host`, `/api/v2`) instead of the session filesystem:
four coordinate-addressed operations (`toc`, `readScroll`,
`writeScroll`, `checksum`), each guarded by a semantic permission
check reporting `{ phextId, coordinate, lane }` (plus `length` for
writes) — never scroll contents. Same operations, capability names and
payloads as the Route B package in `../../stage1/` (relative to the
demo workspace); only the backend differs.

## The key invariant

The SQ API key is held **only** by the runtime:

- the operator starts SQ with `--key`, and puts the same key into
  submilli-server's **encrypted** secret store
  (`submilli server secret put SQ_API_KEY`, server started with a
  secret-store key so the store is actually encrypted);
- the Blueprint declares the secret **by name only**:
  `secrets: { SQ_API_KEY: { store: SQ_API_KEY } }`;
- this package fetches the key per call with `secrets.get` and sets
  the `Authorization` header itself (the curated github/brave
  pattern). It never returns, logs, or checks the key;
- generated code (`main`) gets **no** `http.*` and **no**
  `secrets.get` rules, and `secrets.get` from `main` is refused by the
  runtime even if a Blueprint tries to grant it — `verify-routea.sh`
  test A3 proves all of this with probes.

## For installers

- **Configuration (not secret):** `src/config.ts` declares one
  required value, `sqBaseUrl` — e.g.
  `submilli build publish-local --config sqBaseUrl=http://127.0.0.1:8765`.
  Configuration is compiled into the artifact and inspectable; that is
  fine for a base URL and is exactly why the key is *not* put there.
- **What the package itself requires** (grant under the package's own
  caller list in your Blueprint):
  - `http.get`, `http.post` — narrowed to the SQ host and the
    `/api/v2/*` path prefix;
  - `secrets.get` with `name == "SQ_API_KEY"` — and nothing else.
  There are deliberately **no `fs.*` requires**: the compiled
  artifact's `capabilities.yaml` lists only `http.*` + `secrets.get`.
- **What to grant `main`:** the four operations in
  `capabilities.yaml`, filtered on `phextId == ${vars.phextId}` and,
  for scroll operations, on `coordinate glob "<lane>/*"` per lane. See
  `../blueprint-routea.yaml` — its `main` section is byte-identical to
  the Route B demo's.
- **Server settings:** SQ is plain HTTP, so the Blueprint needs
  `allow_insecure_http: true`, and the server needs
  `network.allow_localhost: true` (or `allow_private`) for loopback
  SQ. That is a local-demo posture; production wants SQ behind HTTPS.

## Endpoint mapping

| Op | SQ call |
|---|---|
| `toc` | `GET /api/v2/get?p=<id>` → parse in-package (exact coordinates) |
| `readScroll` | `GET /api/v2/select?p=<id>&c=<coord>` (empty body + `/get` re-check distinguishes missing from empty) |
| `writeScroll` | `POST /api/v2/update?p=<id>&c=<coord>`, raw body = scroll text (whole-scroll overwrite; auto-saved; idempotent) |
| `checksum` | `GET /api/v2/get?p=<id>` → SHA-256 in-package (`submilli:crypto`) over the returned bytes |

Fidelity note: `/get` returns the raw file, but `submilli:http`
decodes response bodies as UTF-8 text. Phext delimiters are
single-byte UTF-8 control codes, so any phext whose scroll text is
valid UTF-8 round-trips byte-exact (the demo fixture does, and
verify-routea.sh's host-side parse agrees with SQ). SQ's
`json-export` was *not* used: earlier ocbox work found it lossy for
tabs/backslashes. A phext containing invalid-UTF-8 scroll bytes would
be lossy through this surface — SQ offers no raw-bytes download
endpoint in v0.6.0.
