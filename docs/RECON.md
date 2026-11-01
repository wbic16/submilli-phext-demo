# Submilli × Phext — Integration Recon Report

**Repo:** https://github.com/submilli/submilli-runtime (public, Apache-2.0)
**Checked at:** commit `aeaded70645f205cac170435ceb7d11c25753be6` ("Add the @submilli/browserbase curated package (#318)"), workspace version **0.5.1**, 2026-11-01
**Method:** shallow `git clone --depth 1` into `/tmp/submilli-recon/submilli-runtime` (no credentials), full read of `docs/`, `crates/`, `packages/`, `examples/` in the clone, plus the live docs pages https://submilli.ai/docs/blueprints and https://submilli.ai/docs/quickstart read in full via browser. Every claim below names the file or URL it came from. Anything not read in a source is marked **UNVERIFIED**.
**Scope note:** recon only. No integration code was written, nobody was contacted, nothing was pushed.

---

## 0. TL;DR for the spec writer

1. **The native integration surface is a TypeScript Package, not Rust and not MCP.** Packages are TS libraries whose exported functions declare a capability in a JSDoc tag and enforce it with a `check()` call. The fields passed to `check()` are exactly what Blueprint filters can test — and a Package may report **computed** fields it looked up itself, not just its arguments (`docs/part-3-packages/02-export-a-function.md`, "Design the payload"). A phext Package can therefore report `phextId`, `coordinate`, and `lane` as strings and Blueprints can filter on them with `==`, `glob`, and `matches`. (§3.2)
2. **Two real backend routes exist for that Package, both proven by curated Packages in-repo:**
   - **Route A — SQ over HTTP:** Package calls an external service with `submilli:http` + `submilli:secrets`, exactly like `@submilli/github`, `@submilli/brave-search`, `@submilli/slack-bot`. SQ's HTTP API (`/api/v2`: `toc/select/insert/update/delta/checksum/query`, locally verified in the ocbox work, `~/workspace/ocbox-phext/SPEC-v0.2.md` §2) is just another HTTPS/HTTP API to wrap.
   - **Route B — in-Package phext engine + VFS volume:** Packages may also use `submilli:fs` on the Blueprint's filesystem (`@submilli/gmail`, `@submilli/google-drive`, `@submilli/notion` all do). A pure-TS phext parser vendored into the Package could read/write a `.phext` file in a `per_session` dir or an operator-declared **named volume**, with no SQ server at all. Costs: a TS phext implementation does not exist in any source checked (**UNVERIFIED** that one exists anywhere; Will's parsers on hand are Python `~/workspace/phext/parse_phext.py` and Rust libphext/SQ), whole-file rewrite semantics, and no SQ `delta`/`checksum` machinery.
3. **MCP wrapping is real but semantically coarse — do not lead with it.** An MCP server declared in a Blueprint becomes a virtual Package `@mcp/<name>`, but its permission check reports **only `tool` and `transport`** — tool *arguments are not reportable or filterable at all* (`docs/part-6-reference/mcp-servers.md`, "The capability"; code: `crates/interpreter/src/runtime/mcp.rs:138` builds context `{"tool": tool, "transport": "streamable_http"}`). You cannot write a coordinate rule over an MCP phext tool. The docs themselves advise putting a Package in front of a broad MCP tool (`docs/part-2-blueprints/06-add-an-mcp-server.md`).
4. **Capability names match exactly — no wildcards.** `fs.write` does not imply `fs.mkdir`; first matching rule wins; default is deny (https://submilli.ai/docs/blueprints; `docs/part-6-reference/permissions.md`). A phext Package needs **one granular capability per operation** (`…/scroll.read`, `…/scroll.write`, `…/toc.read`, …), each granted separately.
5. **State today:** sessions + session KV + VFS files in SQLite-backed server storage; durable execution is opt-in (`durable_execution: false` by default), effect history is inline-in-SQLite ≤64 KiB or encrypted object files under `<volume_dir>/durable-objects/<session-id>/<run-id>/`; audit is **logfmt lines** (`schema=submilli.audit/1`), not a queryable store. (§5)
6. **Demo shape is already proven by their own material:** the README video (support agent, $18 replacement allowed, $42 blocked until Blueprint limit raised $25 → $50, `readme.md`) and the quickstart's prompt-injection denial (`listCharges("hooli")` denied after legitimate work completes) map 1:1 onto "agent may read/write only its bound phext + coordinate lane; injection tries another phext/coordinate; denial is runtime-enforced." (§8)

---

## 1. Crates layout

Source: root `Cargo.toml` (workspace members, version 0.5.1, edition 2024), each crate's `Cargo.toml` / `README.md` / `src/`.

| Directory | Crate name | Purpose (grounded) |
|---|---|---|
| `crates/interpreter/` | `submilli-engine` | Compiles the Submilli TypeScript subset to WebAssembly (wasmtime fork `submilli-wasm`) and runs it in a sandbox where every effect goes through a capability check. Embedder supplies host services via traits on the store: policy (`SecurityCheck`), HTTP, secrets (`SecretProvider`), model calls (`LlmProvider`), sub-agents (`AgentProvider`), skills (`SkillProvider`), embeddings, filesystem, session KV, MCP transport, tools. (`crates/interpreter/README.md`; traits in `crates/interpreter/src/runtime/{security,secrets,llm,agents,skills,embedding,filesystem,session_kv,mcp,tools}.rs`) |
| `crates/submilli-policy/` | `submilli-policy` | Capability policy: filter language, permission rules, the check that evaluates them. Rules are per-caller, walked in order, first match decides, else default. `Rules::explain` gives reasoning. With feature `engine`, provides `PermissionCheck`, the `SecurityCheck` the CLI/server install. (`crates/submilli-policy/README.md`, `src/{filter,rules,check,fields}.rs`) |
| `crates/submilli-blueprint/` | `submilli-blueprint` | Blueprint YAML parsing/model: variables, secrets, MCP block, LLM/embedding blocks, auth proxy, git, VFS paths, endpoints. (`src/{lib,mcp,secrets,variables,llm,embedding,auth_proxy,git,vfs_paths}.rs`) |
| `crates/submilli-build/` | `submilli-build` | Build-side Package orchestration: parses `submilli.toml`, compiles Packages in dependency order, derives `capabilities.yaml`, installs artifacts into a Package store, `PackageStore::load_closure`, `submilli.lock` (GitHub deps pinned to SHA + source hash). Artifact format versioned in lockstep with the engine. (`crates/submilli-build/README.md`, `src/{artifact,capabilities,driver,package_store,resolve,lockfile,scaffold}.rs`) |
| `crates/submilli/` | `submilli` (bin `submilli`) | The CLI: `build`, `blueprint`, `run`, `check`, `search`, `docs`, `builtins`, `secret`, `server …` (blueprint apply, session, run-code, runs, packages install, secret, status/stop), `install`, `mcp`, `github`, `skill`, `upgrade`, plus a `playground` host. Uses sqlx/SQLite for its local stores. (`src/main.rs`, `src/commands/`) |
| `crates/submilli-server/` | `submilli-server` (bin + lib) | The server: axum HTTP + MCP endpoints, sessions, runs, recovery, audit, auth, SQLite adapters. Notable subtrees: `src/handlers/`, `src/application/{blueprints,sessions,secrets,mcp_grants}.rs`, `src/adapters/{blueprint/sqlite,session/sqlite,unit_of_work,secret_store,history}`, `src/audit.rs`, `src/mcp/`, `src/runner/`. |
| `crates/submilli-durable/` | `submilli-durable` | Durable **filesystem** services implementing the engine's filesystem traits with journaled, replay-safe operations: per-operation state machines (`Initial → Prepared → Completed`), effect IDs, history, `UnitOfWork` contract. Explicitly: "It has no dependency on the server or SQLx"; "The framework integration is future work" for enforcing skip-completed ordering at that layer. (`crates/submilli-durable/README.md` — actually the crate doc comment in `src/lib.rs` / package README text; `src/{history,codec,unit_of_work,filesystem/}.rs`) |
| `crates/submilli-shared/` | `submilli-shared` | Glue used by CLI + server: host secret resolution (`BlueprintSecretProvider`, cipher), LLM tooling, MCP client/auth, GitHub install helpers, TLS, prompt/docs scoping. (`src/{host,secret_store,mcp,mcp_auth,llm,github}.rs`) |
| `crates/conformance/` | `conformance` (publish=false) | test262 (ECMAScript) + TypeScript-inference conformance suites; nightly-only. Not an integration surface. (`crates/conformance/README.md`) |

**Repository top level** (`readme.md`, "Repository"): `crates/` Rust, `packages/` curated Packages, `charts/` Helm, `docs/` + `docs-site/` the book at submilli.ai/docs, `skills/` the skill that teaches coding assistants to write Blueprints/Packages, `examples/` quickstart + harness examples.

---

## 2. The Blueprint model (checked source: https://submilli.ai/docs/blueprints)

Read in full 2026-11-01; corroborated field-by-field against `docs/part-6-reference/blueprint-file.md`, `docs/part-6-reference/permissions.md`, and `docs/part-6-reference/filter-language.md` in the clone. Where the web page simplifies, the reference docs govern (noted).

A Blueprint is YAML, written by a human/operator outside the model, registered on the server under a `name`. It is "the plan for the environment" each session is built from. Parts:

1. **Packages** — the TS Packages the program may import.
2. **Permissions** — rules **per caller**, plus `default` (deny unless set otherwise).
3. **Secrets and variables** — secrets declared **by name only** (values live in the secret store or are supplied by the harness at session open; never in the file); variables are values the **trusted application binds when it opens a session**, for rules to test.
4. **Auth proxy** — adds a credential to outbound HTTP **outside the program**; the program sees the response, never the header.
5. **MCP servers** — declared here; each becomes an importable virtual Package `@mcp/<name>`.
6. **Files** — what filesystem the program sees: nothing (`none`), a per-run scratch dir (`ephemeral`, the default), a session-persistent dir (`per_session`), or an operator-declared volume (`named`); **idle session lifetime (`idle_timeout`, default 24h) is set here too.**

### 2.1 How a call is decided (critical for phext design)

- `permissions` is a map **caller → ordered rule list**. `main` = the generated program. **Each Package has its own caller list** governing what the Package *itself* may do (its `requires`), separate from what `main` may call on it (its `provides`). A stdlib operation is attributed to the code that calls it; a Package's `check()` is attributed to the Package's caller. (`permissions.md`, "Callers")
- Rule = `capability` + optional `filter` + `action: allow|deny` (an optional `name` label also exists in the reference — the Blueprints page omits it).
- **First matching rule wins**: walk the caller's list top-to-bottom; first rule whose capability matches **and** whose filter is absent or true decides; if none matches, `default` decides.
- **Capability names match EXACTLY — no wildcards.** "There is no `fs.*`, so allowing `fs.write` doesn't allow `fs.mkdir`." ⇒ a phext Package must mint granular names, one per operation, and a Blueprint must grant each one it means to allow.
- **Filters** (`filter-language.md`): a comparison is `field operator value`, value is a literal or `${vars.NAME}` — never another field. Operators: `==`, `!=`, `<`, `<=`, `>`, `>=` (numbers), `glob` (string, whole-field; `*` = any run **including across `/`**, `?` = one char, `\` escapes; case-sensitive; variables inside a glob are taken literally and cannot widen it), `matches` (Rust `regex`, partial match, **no variables allowed**), `contains` (array membership). Combine with `and` / `or` / `not` + parentheses (`not` > `and` > `or`).
- **A field the operation didn't report never matches** — for every operator, `!=` included (but `not (field == x)` on a missing field is *true* — a footgun to avoid in deny rules). Filter evaluation never errors at run time; an undecidable comparison is false. However, **a filter that tests a field the capability doesn't declare is a hard error at `blueprint lint` / registration** (`permissions.md`, "Errors when the Blueprint is read").
- **Variables cannot be changed by the program.** Bound by the application at session open (REST `variables` object, CLI `--var`, or MCP `Submilli-Variables` header / `_meta.variables`), snapshotted with the session, survive restarts, no update API. Canonical pattern: `filter: customerId == ${vars.customerId}` with `variables: { customerId: { required: true } }`.
- **Refusals no rule can change** (`permissions.md`): `secrets.get` from `main` (Packages only, by name, e.g. `filter: name == "GITHUB_TOKEN"`), `variables.get` from `main`, writes to a read-only volume mount.
- Blueprint top-level keys are a **closed set** (unknown key = parse error): `kind, name, allow_insecure_http, idle_timeout, tool_call_timeout, vfs, secrets, variables, packages, auth_proxy, git, default, permissions, mcp, llm, embedding` (`blueprint-file.md`).

**Phext implication (direct):** the natural Blueprint binding is a variable — e.g. `phextId: { required: true }` (and possibly a `lane` / coordinate-prefix variable) bound by the host application per session — with rules like `filter: phextId == ${vars.phextId} and coordinate glob "${vars.lane}/*"`. That works **only if** the Package reports those fields on every operation (§3.2) and only on a native Package — not over MCP (§6).

---

## 3. Packages

### 3.1 Anatomy (checked source: https://submilli.ai/docs/quickstart, verified against `examples/quickstart/` in the clone)

A Package is **TypeScript, not Rust**. Scaffold:

```sh
submilli build init @pied-piper/billing package
# created submilli.toml
# created package/src/lib.ts
# created package/docs/readme.md     <- the readme the MODEL reads (required; build fails without it)
# created package/README.md          <- the readme for the human installer (not read by the build)
# created package/tests/lib.test.ts
```

Project layout (full reference: `docs/part-6-reference/package-manifest.md`):

| Path | Holds |
|---|---|
| `submilli.toml` | Manifest: one `[[package]]` per Package (`name` = `@org/name` — org must be a GitHub-org-shaped scope, `version` = any string, `description`, `keywords`, `path`, `dependencies`), plus optional top-level `[dependencies]` (version string → local store; or `{ github = "github.com/org/repo", rev = "<full 40-char SHA>" }` → fetched from GitHub, pinned in `submilli.lock` with `sha256:` source hash). Branches/tags refused as dep refs. |
| `<path>/src/lib.ts` | Entry point; its exports are the Package's API. Other modules under `src/**/*.ts` imported by relative path. `.subm` accepted wherever `.ts` is. **No npm packages, no Node modules** (`docs/part-1-start-here/05-packages.md`, "Why not npm"). |
| `<path>/src/config.ts` | Optional build/install-time configuration: `export declare const baseUrl: string;` (required, supplied via `--config baseUrl=…` at build/install) or `export const x = <primitive default>`. Primitives only; values are **compiled into the artifact and inspectable** — "Credentials: use secrets." No Blueprint/session overrides. (`docs/part-6-reference/package-configuration.md`) — this is the right slot for an SQ **base URL**, never for an SQ key. |
| `<path>/capabilities.yaml` | **Generated, never authored** — rewritten by every `build check` / `test` / `publish-local`; shipped inside the installed Package; read by `blueprint add-package`. See §3.2. (The quickstart readme in-repo confirms: "`submilli.toml` and `package/capabilities.yaml` are not in the table because you never write them — `submilli build` produces them." — `examples/quickstart/readme.md`. Correction to a casual reading of the web quickstart: `submilli.toml` *is* scaffolded by `init`, then edited; `capabilities.yaml` is purely derived.) |
| `<path>/tests/**/*.test.ts` | Tests run by `submilli build test`; use `import { label } from "submilli:test"`, plain `assert`, `expectException`. Doc examples: every fenced `ts` block in `docs/readme.md` is compile-checked as a test. |
| `<path>/docs/readme.md` | Required, ≤4 MiB, copied into the installed Package, returned by the server's docs tool / HTTP API with a generated `## Declarations` section. Supports conditional regions `<!-- submilli:if capability="…" -->` shown only when the Blueprint could allow that capability for `main`. |

**Capability declaration — the two lines that make an operation** (`05-packages.md`; `docs/part-3-packages/02-export-a-function.md`):

```ts
import { check } from "submilli:security";

/**
 * List the charges on one customer's account.
 * @capability pied-piper.example/charges.list { customerId: string }
 */
export function listCharges(customerId: string): Charge[] {
    check("pied-piper.example/charges.list", { customerId });
    …
}
```

- The **JSDoc `@capability` tag declares**: name + the fields a rule may test. Name convention: `<domain>/<resource>.<verb>`, one per operation, "so a Blueprint can allow reading without allowing writing."
- The **`check()` call enforces**: it asks the Blueprint whether *this caller* may do this *with these values*, and throws `PermissionDeniedError` if not. It must be called **directly in the exported function's body, before the effect** (the request, the write). The compiler warns on a `check` in a nested function/helper path, on a tag with no `check`, and on a `check` with no tag; a `check` field missing from the tag is a build **error**. Use `--deny-warnings` in CI.
- Calls are **synchronous** — no `await` anywhere in Package or program code.
- A function may carry **several `@capability` tags** (multi-capability operations exist in the wild — see gmail `downloadAttachment`, §4.2).

**Build / publish flow** (quickstart, verified):

```sh
submilli build check --deny-warnings     # -> "checked @pied-piper/billing v0.1.0"
submilli build test  --deny-warnings     # -> "2 passed, 0 failed across 1 files"
submilli build publish-local             # -> installed @pied-piper/billing v0.1.0 -> $SUBMILLI_HOME/packages/@pied-piper/billing
submilli blueprint lint --deny-warnings blueprint.yaml
submilli search billing                  # discovery: name/description/keywords/exports, substring, case-insensitive
submilli docs @pied-piper/billing        # declarations + docs/readme.md, filtered by Blueprint when --blueprint given
```

Server-side install of a published Package is by GitHub repo: `submilli server packages install OWNER/REPOSITORY @OWNER/name [--config k=v]` or `POST /v1/packages/install` (`package-configuration.md`; `docs/part-4-server/08-install-private-packages.md`). Private repos need a server GitHub token (Contents: read-only).

**Programs** (what the agent writes): a TS file importing the Package — `import { listCharges } from "@pied-piper/billing";` — with a `main()` entry point; `main`'s return value is the output. The program never sees the API URL, the credential, or the Blueprint binding.

### 3.2 (a) What fields can an operation report? — YES: `phextId` + `coordinate` + `lane` works

Sources: `02-export-a-function.md` ("Design the payload"), `package-manifest.md` ("@capability", "capabilities.yaml"), `filter-language.md`, `permissions.md`, code `crates/interpreter/src/runtime/security.rs` (`SecurityCheck::check(caller, capability, context: &serde_json::Value)` — the context is an arbitrary JSON object built by the Package).

The design rule, verbatim in substance: *"A rule never sees the request the Package sends to the service. It sees the capability's name and the payload the Package passes to `check`, and nothing else, so a fact that isn't in the payload can never appear in a rule. Build the payload for the rules people will want to write, not from the arguments the function happens to take."*

Field forms in the `@capability` tag:

| Form | Meaning |
|---|---|
| `customerId` | a parameter of that name (type = parameter's type) |
| `orderId: $id`, `team: $input.teamId` | a parameter, or a dotted path inside one, under another name |
| `customerClass: string`, `amount: number`, `tags: string[]` | **a value the Package computes**, with its type as written |
| `kind: "goodwill"`, `version: 2`, `live: true`, `parent: null` | a fixed value |

And the canonical computed-field example is exactly the phext-shaped one: `applyCredit(customerId, amount)` **looks up** whether the customer is premium and reports `customerClass` — a fact *not in the request and not passed by the caller* — because "Don't take such a fact from the caller, because the caller is the program you are guarding against." The same page mandates: **put the session's scope field in every operation's payload, including operations that take only an id** (their example: a comment operation fetches the issue, reads its team, checks `{ teamId, issueId }`), and **normalize before the check — read each property once into a `const`, check the value you will actually send, and use that same `const` for the effect** (the compiler warns on a second read of a value that reaches a `check`; the github Package's policy tests in `packages/github/tests/policy/` exist largely to prove this).

Types a filter can test: `string`, `number`, `boolean` (and `null` via `==`/`!=`); a Package field may also be an **object**, whose members a filter names with a dot (`order.total`), and arrays via `contains` / `items.0.sku` (`permissions.md`, `filter-language.md`).

**Applied to phext — checked conclusions:**

- An operation like `selectScroll(phextId, coordinate)` can declare `@capability phext.example/scrolls.select { phextId: string, coordinate: string, lane: string }` where `lane` is **computed by the Package** (derived from the coordinate, e.g. its first group) — or the coordinate's components can be reported as an object. All three are plain strings, so every filter operator applies:
  - `phextId == ${vars.phextId}` — bind the session to one phext (the `customerId` pattern, 1:1).
  - `coordinate glob "1.1.1/1.2.1/*"` — `glob`'s `*` crosses `/`, so a coordinate prefix glob works on the canonical `a.b.c/d.e.f/g.h.i` string form.
  - `coordinate matches "^1\\.1\\.1/"` — regex available, but **no `${vars.*}` inside `matches`**, so variable-bound lanes must use `glob` (where the variable is inserted literally) or `==`, not regex.
- **Every operation must report the scope fields, every time.** An operation that omits `coordinate` (a `toc` listing, say) makes any coordinate condition on it false — so either give listing its own capability reporting `{ phextId }` only, or have the Package resolve and report the coordinates it will touch before checking. This is the single most important design constraint the docs impose.
- Declaring is enforced mechanically: fields in `check()` but not the tag = build error; filter on an undeclared field = lint/registration error. The spec can rely on the toolchain to keep the phext Package honest.
- One simplification in the curated github Package to be aware of: `packages/github/capabilities.yaml` repeats a large union field set on many `provides[]` entries, because its operations share one context-object type in `src/lib.ts` (3,345 lines). A phext Package should use **per-operation payload objects** (the pied-piper style) so each capability's declared fields stay minimal and lint-precise. (Observation from the file; the manifest reference confirms fields from multiple callables declaring one capability are merged.)

Derived `capabilities.yaml` shape (from the quickstart, verified in `examples/quickstart/package/capabilities.yaml`):

```yaml
namespace: pied-piper            # the @scope without '@'
provides:
- name: pied-piper.example/charges.list
  description: List the charges on one customer's account.
  fields:
    customerId: { type: string }
requires: []                     # what the Package itself needs — see §3.3
```

### 3.3 (1) How a TS Package reaches an external service — the `requires[]` pattern

Sources: `packages/brave-search/{src/lib.ts,capabilities.yaml}`, `packages/github/{src/lib.ts,capabilities.yaml,readme.md}`, `packages/slack-bot/capabilities.yaml`, `packages/gmail/capabilities.yaml`.

A Package reaches outside **only** through `submilli:*` stdlib modules. For an HTTP API with a credential, the pattern is mechanical and identical across curated Packages:

```ts
// packages/brave-search/src/lib.ts (55 lines — the smallest complete example)
import { get } from "submilli:http";
import secrets from "submilli:secrets";
import { check } from "submilli:security";

export function search(query: string, options: SearchOptions = {}): SearchPage {
    check("brave.com/search", {});
    return normalizeSearchJson(request("web/search", params), query, options.offset ?? 0);
}
function request(path: string, params: string): string {
    const token = secrets.get("BRAVE_SEARCH_API_KEY");   // throws/missing -> typed error
    if (token === undefined || token.trim().length === 0) { throw new BraveSearchError("missing_credentials", "Bind BRAVE_SEARCH_API_KEY in the blueprint…"); }
    headers.set("X-Subscription-Token", token);
    const response = get("https://api.search.brave.com/res/v1/" + path + params, headers);
    …
}
```

The build **derives** `requires[]` from the code — one entry per distinct stdlib capability + statically-derivable filter (host from a literal/constant URL, secret name from a literal, etc.):

```yaml
# packages/brave-search/capabilities.yaml
requires:
- capability: http.get
  filter: host == "api.search.brave.com"
- capability: secrets.get
  filter: name == "BRAVE_SEARCH_API_KEY"
```

```yaml
# packages/github/capabilities.yaml (tail) — same pattern, more verbs
requires:
- { capability: http.get,    filter: host == "api.github.com" }
- { capability: http.post,   filter: host == "api.github.com" }
- { capability: http.post,   filter: host == "api.github.com" and path == "/graphql" }
- { capability: http.put,    filter: host == "api.github.com" }   # + patch, delete
- { capability: secrets.get, filter: name == "GITHUB_TOKEN" }
```

How credentials are held (three layers, all checked):

1. **Blueprint declares the name + source, never the value:** `secrets: { GITHUB_TOKEN: { store: github_token } }` or `{ harness: { required: true } }` (value supplied by the application at session open/rebind; harness secrets are kept **in memory only** and do not survive a server restart — sessions then answer `409 session_requires_secrets` until rebound, `http-api.md`).
2. **Value lives in the encrypted secret store:** server-side `submilli server secret put GITHUB_TOKEN`, local `submilli secret put …` for `submilli run`. Store key = base64 of 32 bytes, from `SUBMILLI_SECRET_KEY` env or `--secret-store-key-file`; **without a key the store is off** and secret commands refuse. The same key encrypts `submilli:session` state and seals session cursors. (`server-settings.md`, "`secret_store`"; `packages/github/readme.md`, "Setup")
3. **Package reads it at call time** via `secrets.get("NAME")` — checked under the **Package's own caller list** (`filter: name == "…"`), and refused from `main` unconditionally. Program code never sees the value.

The Blueprint author grants the Package's `requires` under the Package's caller key — `submilli blueprint lint --fix` can add them; lint errors if a required operation has no matching rule.

**For a phext→SQ Package, this pattern copies verbatim:** `submilli:http` verbs against the SQ host base URL, `secrets.get("SQ_API_KEY")` (or whatever the Blueprint names it), base URL from `src/config.ts` (`--config sqBaseUrl=…` at install — inspectable, non-secret) or a literal constant if the deployment is fixed. `requires[]` will derive as `http.get/post … host == "<sq-host>"` + `secrets.get`. Two SQ-specific wrinkles, both checked:

- **SQ's HTTP API is plain HTTP locally** (`sq host <port>`, `~/workspace/ocbox-phext/SPEC-v0.2.md` §"SQ v0.6.0 HTTP surface"). Submilli refuses `http://` unless the Blueprint sets `allow_insecure_http: true`, and on a server, **hosts resolving to private/loopback addresses are refused unless the server operator allows them** (`network.allow_private` / `network.allow_localhost` in `server-settings.md`; stdlib rule: "On a server, hosts that resolve to private addresses are refused unless the server allows them"). A localhost/tailnet SQ therefore needs operator-side network grants + `allow_insecure_http` — or SQ behind an HTTPS reverse proxy. This is a deployment blocker to plan around, not a code problem. (Tailnet-IP SQ: **UNVERIFIED** whether the egress guard treats `100.x` CGNAT space as private — check before relying on it.)
- SQ auth accepts `Authorization: <key>` / `Authorization: Bearer <key>` (ocbox SPEC §2, locally verified against SQ 0.6.0) — compatible with the Package setting the header itself from `secrets.get`. (The Blueprint `auth_proxy` is an alternative for direct-HTTP-from-`main`, but a Package holding the secret is the curated pattern.)

### 3.4 (3) The `submilli:*` standard library — full list

Source: `docs/part-6-reference/standard-library.md` ("Modules" table), cross-checked against `crates/interpreter/src/stdlib/` in code.

| Module | What it does | Gated by |
|---|---|---|
| `submilli:fs` | Program's filesystem: read/write/list/stat/move/copy/remove, byte iterators | `fs.read/write/stat/list/mkdir/remove/move/copy` (each separate) |
| `submilli:http` | HTTP requests; downloads into the filesystem | `http.get/post/put/patch/delete/head/options`, `http.request`, `http.download` |
| `submilli:llm` | Model calls: `call`, `batch`, `models` (providers/models declared in Blueprint `llm:` block) | `llm.call` (fields: `model`, `prompt_count` — prompt text is never in the context) |
| `submilli:embedding` | Text embeddings: `embed`, `models` (Blueprint `embedding:` block) | `embedding.embed` (fields: `model`, `input_count`) |
| `submilli:session` | Session-scoped KV: `get/has/set/remove/list`; also `registerFinalizer/unregisterFinalizer` for Package cleanup | `session.read/write/remove/list`, `session.finalize` |
| `submilli:git` | Repos in the VFS: init/clone/fetch/pull/commit/branches (needs Blueprint `git:` block) | `git.init/clone/fetch/commit` |
| `submilli:code` | Numbered reads, search, glob, tree, anchored edits, diffs over the program's files | rides on `fs.read/list/stat/write` |
| `submilli:crypto` | SHA-256, SHA-512, HMAC-SHA-256, random bytes | nothing |
| `submilli:url` | URL / query-string parsing and building | nothing |
| `submilli:uuid` | UUID v4 and v7 | nothing |
| `submilli:variables` | Immutable session configuration, **Packages only** | `variables.get { name }` |
| `submilli:secrets` | A declared secret's value, **Packages only** | `secrets.get { name }` |
| `submilli:security` | `check(capability, context)`, **for Packages** | the capability it names |
| `submilli:test` | `label`, `expectException`, for test files | nothing |

In code but **not in the docs' module table** (`crates/interpreter/src/stdlib/{agents,skills}/`, `crates/interpreter/src/runtime/{agents,skills,mcp}.rs`): `submilli:agents` (sub-agent provider), `submilli:skills` (skill provider), and the internal `submilli:mcp.call(server, tool, argsJson)` host function that backs `@mcp/*` virtual Packages. Treat these as embedder/harness plumbing, **not** documented Package-author surface — do not design on them without further checking (**flagged, partially unverified**: declarations exist in code; no docs page describes them as Package APIs).

Language note: programs/Packages are a **strict TypeScript subset** compiled to WASM (`docs/part-6-reference/language.md`, `built-ins.md`) — synchronous, no npm/Node APIs, no `eval`. Anything a phext Package needs (parser, coordinate math) must be written in, or ported to, that subset.

---

## 4. Files, session state, and (2)/(c): the in-Package phext route

### 4.1 What the Blueprint's Files options actually are

Source: `blueprint-file.md` ("vfs"), `docs/part-2-blueprints/03-keep-files-and-state.md`, `server-settings.md` ("Directories", "`volumes`").

| Mode | Backing | Lifetime |
|---|---|---|
| `none` | — | every `submilli:fs` call fails |
| `ephemeral` (default) | scratch dir per run under `<volume_dir>/ephemeral/` | deleted when the run ends |
| `per_session` | dir under `<volume_dir>/sessions/<session-id>/` | as long as the session (until close / `idle_timeout` expiry; closing deletes `submilli:session` state **and** `per_session` files) |
| `named` | operator-declared volume: `managed-local` → `<volume_dir>/managed-local/<name>/`, or `local-path` → an operator path the server never creates/deletes | **across sessions and restarts; shared with every Blueprint that names it; the server never deletes a volume's files** |

Plus: **mounts** — up to 16 named volumes grafted at guest paths under any non-`none` root (e.g. root `per_session` + `/memory` → named volume, read-write; `/handbook` → named volume, read-only), each with optional `subPath` (which may be `users/${vars.userId}` — a variable as one whole path component) and `access` that can only *narrow* the server's declaration. `size_limit` applies to `ephemeral`/`per_session` roots (a write past it throws catchable `QuotaExceededError`); a named volume's limit is set once by the operator and covers all sessions/Blueprints sharing it. `submilli run` (local CLI, no server) refuses Blueprints naming volumes — volumes are server-only; locally, `submilli run --vfs ./dir` shares a plain directory between runs.

On disk the server keeps, under `$SUBMILLI_HOME` (default `~/.submilli`): SQLite DB at `server/db/submilli.db`, `server/sessions/` (session lifecycle records, so sessions/idle-timeouts survive restart), `server/packages/`, `server/volumes/`, `server/secrets/` (legacy import path — current secrets live in the DB, per server help text in `server-settings.md`), and `server/db/submilli.db-last-runs/` for last-runs >64 KiB.

### 4.2 Can a Package use `submilli:fs`? — Yes, proven in production Packages

This is the load-bearing fact for Route B, and it is not hypothetical:

- `packages/gmail/src/lib.ts`: `import { read, stat, write } from "submilli:fs";` — its `capabilities.yaml` `requires[]` includes `fs.read`, `fs.stat`, `fs.write` (no derivable filter). Its `downloadAttachment` op declares **two** capabilities — `@capability submilli/gmail.downloadAttachment { path: string }` **and** `@capability fs.write { path: string, max_bytes: number }` — and calls both `check("submilli/gmail.downloadAttachment", { path })` and `check("fs.write", { path, max_bytes: DOWNLOAD_MAX_BYTES })` before writing decoded bytes into the VFS.
- `packages/google-drive/src/lib.ts`: `readBytes`/`stat` from `submilli:fs` to stream a VFS file up to Drive in 8 MiB chunks.
- `packages/notion/src/uploads.ts`: same pattern.

Attribution: those fs calls are judged under the **Package's caller list**, not `main`'s (`permissions.md`, "Callers"). So a Blueprint for Route B grants, e.g., `main` → the phext operations, and `'@wbic16/phext'` (name illustrative) → `fs.read`/`fs.write` with `filter: path glob "/phext/*"` or a single file path. Note a Package fs call is *also* visible to `main`-style path filtering only via the Package's own list — the path is the finest granularity the fs layer itself knows; **coordinate granularity exists only in the Package's own `check()` payload** (§3.2). That layering is exactly right: fs rules confine the Package to the phext file(s); phext rules confine the program to coordinates inside them.

`submilli:fs` API surface relevant here (`standard-library.md`, "`submilli:fs`"): `readText`/`writeText` (UTF-8, atomic temp+rename for writes), `read`/`write` (`Uint8Array`), `readBytes(path, offset, length)` random access, `bytes(path, chunkSize)` constant-memory streaming iterator, `lines(path)`, `stat/size/exists/list/mkdir/move/copy/remove`, `info()` (reports mode/volume/sizeLimit at runtime). Whole-file reads return `undefined` past `maxReadSize()` — default **50 MiB** in code (`crates/interpreter/src/runtime/mod.rs`: `DEFAULT_FS_MAX_READ_SIZE = 50 * 1024 * 1024`).

### 4.3 What storing a `.phext` natively in the VFS would mean — honest assessment

**In favour (all checked):**

- A `.phext` is plain bytes: text plus the 9 delimiter **control bytes** `0x01, 0x1F, 0x1E, 0x1D, 0x1C, 0x1A, 0x19, 0x18, 0x17` (Library→Scroll; local ground truth `~/workspace/phext/parse_phext.py`). Those bytes are single-byte ASCII controls, hence valid UTF-8 code points — but `readText` is documented to strip a BOM and replace invalid bytes with U+FFFD, so the **byte APIs (`read`/`write`/`readBytes`/`bytes`) are the safe choice** for a phext Package; a SHA-256 round-trip test (cf. `submilli:crypto`) should be a build-test gate. *Round-trip of control bytes through the WASM string/byte layer is **UNVERIFIED** until that test is run.*
- Current real phexts fit whole-file handling: `emise.phext` 56 KB, `incipit.phext` 1.1 MB, `choose-your-own-adventure.phext` 4.4 MB (local `ls`, 2026-11-01) — all far under the 50 MiB `maxReadSize` and under a plausible `size_limit`. Streaming (`bytes()`) exists if that changes.
- A **named volume is the only VFS option with the right lifetime for a real phext**: cross-session, cross-restart, shared, operator-owned, never auto-deleted. `per_session` is the right lifetime for a *demo sandbox copy* (dies with the session — clean demo hygiene). Mounting the phext volume read-only beside a writable per-session root is a documented, one-fragment Blueprint pattern.
- Session binding maps cleanly: `subPath: users/${vars.…}` shows variables can partition a volume per session binding — an analogous partition per phext/tenant is available at the file level, *in addition to* the Package's coordinate rules.

**Against / costs (checked where noted):**

- **No TS phext implementation exists in any checked source.** Will's working parsers are Python (dead-reckoning, `parse_phext.py`) and Rust (libphext, inside SQ). Route B includes **porting phext addressing to the Submilli TS subset** — real work, and the subset's limits (no npm, sync-only) apply. Effort is bounded (the Python parser is a byte-walk), but it is the route's main cost. **UNVERIFIED:** TS-subset feature gaps that might bite (regex flavour, `Uint8Array` ops) until a spike compiles.
- **Whole-file rewrite per scroll edit.** SQ rewrites the whole phext file on every mutation too (ocbox SPEC: "every mutation re-writes the whole phext file immediately; per-phext writes are serialised by a server mutex; last write wins per scroll") — so this is parity with SQ's *file* behaviour, but Route B loses SQ's *protocol* behaviour: coordinate-addressed `insert/update/select` without the client re-deriving offsets, `toc`, `checksum`, and the `delta` hierarchical checksum map that the ocbox resume flow depends on. A Route-B Package must re-implement `select`/`toc` itself (that *is* the parser port) and gets no delta protocol unless it builds one.
- **Concurrency:** two sessions sharing one named volume have no documented locking between them; the durable-execution reference explicitly notes "shared-volume advisory locking is not yet available" (for durable writers to the same volume, attempts are serialised while active; ordinary executions and external tools "still require exclusive access"). A multi-writer phext on a named volume is a last-write-wins design unless the Package/harness serialises writers — same caveat SQ has, minus SQ's server mutex.
- **Seeding problem:** a named volume is operator-declared storage on the server host; getting an existing `.phext` (e.g. a copy of CYOA) into it is an operator file copy (for `local-path`) or a program writing it there through granted fs capabilities — there is no documented "upload file to volume" API. For a demo this is fine (host copies a fixture in); for a product it is a gap to note. (**Checked:** no volume-content endpoint exists in `http-api.md`'s endpoint list.)

---

## 5. Execution / session model, durable execution, audit

Sources: `docs/part-6-reference/http-api.md`, `run-recovery.md`, `server-settings.md`, `audit-trail.md`, `docs/part-1-start-here/06-server.md` + `07-application.md`.

### 5.1 Sessions and runs

- A **session** binds a Blueprint + variable values + harness secrets once; every program run in it uses them. Opened via `POST /v1/sessions { blueprint, variables?, secrets?, tools? }` → `{ session_id }`, or implicitly per MCP connection at `/mcp/<blueprint>` (one connection = one session; variables via headers/`_meta`). Sessions **survive server restart** (lifecycle records in `session_store_dir`, imported into SQLite); harness secrets do **not** (memory only → `409 session_requires_secrets` + `POST /v1/sessions/{id}/rebind`).
- A **run** executes one program: `POST /v1/sessions/{id}/execute { code }` or one-off `POST /v1/execute { blueprint, code, variables }`. Both answer **HTTP 200 even when the program fails**, with `{ status, result, console, error, execution_id … }` (§8.2 for the denial shape). `GET /v1/sessions/{id}/last-run` returns the most recent run with full console (kept as JSON, `max_last_run_size` 64 MB default; oversize → `413`).
- **Session state beyond files:** `submilli:session` KV (typed get/set/remove/list, checked per key) — encrypted with the secret-store key when one is configured, unencrypted without one. Closing a session (explicit `DELETE`, idle expiry, Blueprint removal) deletes KV + `per_session` files and runs any Package **finalizers** (§7).
- **Idempotency:** `Idempotency-Key` header on session execute — recorded outcome replayed for same key+same code; different code → `409 idempotency_conflict`; retention 24 h / keep-last 3 by default; ledger on disk beside the session store.
- **Application tools (`@tools`):** a session may declare harness tools; a run can suspend at a tool call (`status: suspended`), the harness answers, the run resumes. Run states: `finished | suspended | running`, plus the durable lifecycle below.

### 5.2 Durable execution (off by default)

- Config: `durable_execution: false` (default). Turning it on **requires persistent SQLite storage and an encryption (secret-store) key**. Scope: persistent **HTTP and MCP session executions only**; one-shot `/v1/execute` stays ordinary. Filesystem must be `per_session`, `named`, or disabled — **`ephemeral` is refused**. Native Windows: unsupported.
- **Effect history:** every completed native effect's outcome is recorded so a recovered run **replays completed steps without repeating them**; a native call with no committed outcome **may execute again** (external effects, incl. HTTP, are *assumed idempotent*). Entries ≤ `durable_objects.inline_threshold` (**64 KiB** default) stay **inline in SQLite**; larger entries go to **encrypted object files** at `<volume_dir>/durable-objects/<session-id>/<run-id>/` with an encrypted SQLite reference — encryption uses the secret-store key with authenticated run/sequence binding. Limits: 64 MiB payload, 1 GiB history per run. Backup = SQLite + whole volume root + key, **together**, server stopped. One server per SQLite DB; multi-node recovery unsupported.
- **Lifecycle:** `queued → running`; on restart, `running` runs recover with a new attempt (fresh fuel/timeout); `stuck` runs are retained and only resume explicitly — `submilli server runs list [--status stuck] [--session ID]`, `runs show RUN_ID`, `runs resume RUN_ID`; HTTP: `GET /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/resume`, `POST /v1/runs/{id}/recover`. Disabling durability leaves unfinished runs stuck. `max_durable_runs` default 4.
- Implementation split: the engine defines `EffectHistory` (`crates/interpreter/src/runtime/effects.rs`) and filesystem traits; `submilli-durable` implements journaled filesystem ops against a `UnitOfWork` the server supplies via a `UnitFactory` callback (SQLite adapter in `crates/submilli-server/src/adapters/unit_of_work/`); journal format version 4. Input bytes are never journaled — fingerprints only; replay re-supplies inputs.

**Phext implication:** a phext Package's SQ HTTP calls are "external effects" — under durable execution, an SQ write with no committed outcome **may be sent twice** after a crash. SQ `insert/update` per scroll is the unit at risk; the demo/spec should either keep durable execution **off** (default) or design phext writes to be idempotent (write-whole-scroll `update` at a coordinate is naturally idempotent; append-style `insert` is not obviously so — **UNVERIFIED** for SQ semantics under duplicate delivery).

### 5.3 Audit trail

Source: `docs/part-6-reference/audit-trail.md`, `server-settings.md` ("Audit trail"), code `crates/submilli-server/src/audit.rs`.

- Format: **one record per line, logfmt**, `stream=audit`, `target=submilli_server::audit`, `schema=submilli.audit/1`, each with `ts` (UTC, ms), `event_id` (UUID), `type`, alphabetical fields after the first five; nested values flattened to dotted keys; lists by position. Destination: the server log output, or a dedicated `logging.audit.file`. Settings: `logging.audit.enabled` (default **true**), `logging.audit.allows: summary|all|none` (default `summary` — allowed ops are summarised with deduped contexts + counts; refusals are always individual).
- Types: **`decision`** (per refused op, + allowed per `allows` setting; fields incl. `caller, capability, context.*` with full `context.payload_json`, `decision, source` (`policy|invariant|read_only|egress_guard|quota`), `rule` (index or `default`), `reason`, `execution_id, session_id, blueprint, blueprint_hash` (SHA-256), `principal`), **`execution`** (started + finished per run: `source_hash`/`source_size` SHA-256 of program source — never the source, `outcome, fuel, memory_peak, model_tokens, wall_ms, vars.*`), **`session`** (created/rebound/deleted/evicted/expired/found/lost), **`admin`** (blueprint_created/replaced/deleted, secret_put/deleted — key name never value, package_installed/removed with digests, oauth events, shutdown), **`auth`** (refused, token never recorded), **`server`** (started/stopped with `settings_hash`).
- Sensitive-data rule (docs' own warning): decision records store the **complete check context** in `payload_json`. **If a phext Package puts scroll *contents* in a check payload, the audit file will hold them.** Phext check payloads should carry `phextId/coordinate/lane` and at most sizes/hashes — which is also all a filter needs. (The 512-char quick-search cut applies to `context.*` text fields, **not** to `payload_json`.)
- There is **no audit query API** in `http-api.md` — the trail is a file/stream the operator reads. Any "audit → phext" idea is a host-side consumer of that file (§7, surface 5).

---

## 6. (b) MCP-server Packages: tool arguments are NOT filterable

Sources: `docs/part-6-reference/mcp-servers.md`, `permissions.md`, `06-add-an-mcp-server.md`, code `crates/interpreter/src/runtime/mcp.rs:138`.

- Declaring `mcp: { <name>: { url, transport?, headers?, auth? } }` in a Blueprint makes the server a virtual Package `@mcp/<name>`: discovery calls `tools/list`, and each tool becomes a typed TS function (input schema → parameters; `outputSchema` → return type, else `unknown`; Submilli carries hand-written output schemas for 18 tool names of GitHub's MCP server only). The server must speak **MCP over HTTP** (streamable_http default, or sse); a stdio server must be put behind an HTTP endpoint first.
- The permission check for **every** tool call is the single capability `mcp.<name>` with context **exactly** `{ tool: string, transport: "streamable_http" }`. A filter on any other field is a lint/registration **error** ("…tests `name`, which the operation doesn't report… its fields are: tool, transport"). Putting the tool in the capability name (`mcp.linear/save_issue`) is refused with a correction message.
- The Packages overview states the consequence plainly: "a rule over an MCP tool can see only the tool's name," and most MCP servers publish no output schema. The add-an-MCP guide adds the security consequence: "Choose tools by what their arguments can do as well as by their names… If an allowed tool is that broad, restrict it where the server runs, or **put a Package in front of it that checks the arguments** and grant the Package instead."
- MCP credentials: static headers with `${secrets.NAME}`, or OAuth2 (`mcp_oauth` registrations, `submilli mcp authenticate`, grants stored server-side) — credential handling is genuinely good; granularity is the problem.

**Verdict for phext:** an "SQ-as-MCP" route (which would first require building an MCP server fronting SQ — SQ itself is not an MCP server in any checked source) could express "may call `select`" but **never** "may call `select` only on phext X, coordinates in lane Y". It discards exactly the semantic-permission property that makes Submilli interesting for phext. Rank it last among the in-runtime routes (§9).

**Contrast — the server's own MCP endpoint** (Submilli *as* an MCP server, for harnesses): `/mcp/<blueprint>` gives the agent tools (execute, last-run, package search, package docs). This is how `agent.py` and the harness examples connect (§8.3). It is a *consumption* surface for phext demos (the agent-facing side), not a phext *integration* surface.

---

## 7. Extension points that are REAL (documented in code/docs)

| # | Extension point | Evidence | Notes |
|---|---|---|---|
| 1 | **New native Package (TS)** | `docs/part-3-packages/*` (start a project, export a function, document, add a dependency, write tests, publish, security review); `submilli build init/new/check/test/publish-local`; `submilli install OWNER/REPO @scope/name`; server `POST /v1/packages/install` | The primary surface. Includes an agent security review (`submilli build security-review`, `--deny-warnings` in CI — `docs/part-5-tutorials/09-verify-a-package-in-ci.md`). |
| 2 | **New Blueprint** | YAML, closed key set; `submilli blueprint init/lint/capability/secret/variable/add-package/add-mcp/auth-proxy/git`; server registration `submilli server blueprint apply` / `PUT /v1/blueprints/{name}`; Blueprints manageable in git (`docs/part-5-tutorials/10-manage-blueprints-in-git.md`) | Policy is data, not code. |
| 3 | **MCP server → virtual Package** | Blueprint `mcp:` block (§6) | Real, but tool-name granularity only. |
| 4 | **HTTP API (host application)** | `docs/part-6-reference/http-api.md`: `POST /v1/sessions`, `POST /v1/sessions/{id}/execute`, `…/rebind`, `GET …/last-run`, `DELETE …`, `POST /v1/execute`, `GET /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/resume` + `/recover`, `GET /v1/sessions/{id}/packages/{search,docs}`, `GET /v1/sessions/{id}/finalizers`, `GET /v1/blueprints/{name}/{prompt,packages/search,packages/docs,builtins,builtins/docs}`, `POST /v1/packages/install`, `GET /v1/packages`, blueprint + secret admin routes (per audit `route` values), `GET /healthz` (unauthenticated). Roles: `admin` vs `user` tokens. | The demo app surface. No audit-read or volume-content endpoint exists. |
| 5 | **MCP endpoint for harnesses** | `/mcp/<blueprint>` (+ `DELETE` with `MCP-Session-Id` to end); tools: execute, last-run, search, docs | How LangChain/Mastra/OpenAI/Claude Agent SDK examples connect (`examples/harnesses/`). |
| 6 | **Application tools (`@tools`)** | Session creation `tools[]`; capability `tools.call { tool }`; suspension/resume protocol in `http-api.md` | Harness-supplied functions a program may call back into. Another argument-blind-ish surface (tool name only) — same caveat class as MCP. |
| 7 | **Package finalizers** | `submilli:session` `registerFinalizer(key, value)` + exported `finalizer(key, value)`; capability `session.finalize { key }`; runs on close/expiry/termination and after crash recovery; `GET /v1/sessions/{id}/finalizers` reports status without arguments/credentials (`standard-library.md`, "Durable package finalizers") | Real and relevant if a phext Package ever holds remote resources (e.g. an SQ session/checkout) needing cleanup. |
| 8 | **Named volumes / mounts** | Server config `volumes:` (`managed-local` / `local-path`); Blueprint `vfs` + `mounts` (§4.1) | The operator-side storage extension point. |
| 9 | **Rust embedding of the engine** | `submilli-engine` + `submilli-policy` + `submilli-build` are published crates (docs.rs pages exist for `submilli-policy` and `submilli-build`); embedder implements traits: `SecurityCheck, SecretProvider, LlmProvider, EmbeddingProvider, AgentProvider, SkillProvider, ToolProvider, McpTransport, Filesystem, SessionKvStore, EffectHistory, MetricsSink, DecisionRecorder` (`crates/interpreter/src/runtime/`) and chooses the `Stdlib` set | Real, but it is "build your own server", not "extend their server". The server's own storage is **not** pluggable in any doc checked: SQLite adapters are concrete (`crates/submilli-server/src/adapters/`), and `submilli-durable`'s `UnitOfWork` is supplied by the server, not by a config/plugin mechanism. **No documented "new storage backend" plugin point for `submilli-server` — flagged as absent, not merely unverified.** |
| 10 | **Skills for coding assistants** | `submilli skill install --agent claude|codex|cursor`; repo `skills/` | Teaches an assistant to author Blueprints/Packages — useful for the demo build itself. |

---

## 8. Examples, quickstart, and the demo material

### 8.1 The simplest end-to-end example (copy this shape)

`examples/quickstart/` in-repo = the web quickstart, runnable, with `verify.sh` asserting both outcomes against a throwaway `SUBMILLI_HOME`:

- `package/` — `@pied-piper/billing`, one operation `listCharges(customerId)` over a fixture (full text in §3.1's pattern).
- `blueprint.yaml` — `variables: { customerId: { required: true } }`, `packages: ['@pied-piper/billing']`, `default: deny`, `main` granted `pied-piper.example/charges.list` with `filter: customerId == ${vars.customerId}`; the Package's own caller list is `[]` (it reads a fixture, needs nothing).
- `total.ts` — the legitimate program: totals pied_piper's charges → `2 charges, 6150 cents`.
- `total-injected.ts` — same, plus the injected "compliance step": `listCharges("hooli")`.
- `app.mjs` — the application (plain Node, ~90 lines): reads a program file, `POST /v1/execute { blueprint: "quickstart", code, variables: { customerId: "pied_piper" } }` with `Authorization: Bearer $SUBMILLI_SERVER_TOKEN`, prints `[result]` / `[denied]`, exits nonzero on denial.
- `agent.py` — optional real-agent version (§8.3). Local-CLI alternative: `submilli run --blueprint blueprint.yaml --var customerId=pied_piper total.ts` after `publish-local` — same enforcement without the server.

### 8.2 Denial shape (checked, web quickstart + `app.mjs` source)

A denied program is **not** an HTTP error: `POST /v1/execute` answers **200** with the failure in the body. `error.kind` is `permission_denied` (released **v0.2.0 reported it as `runtime_error`** with the same diagnostic prefix — `app.mjs` in-repo handles both, with the comment "Released v0.2.0 reports policy denials as runtime_error with this diagnostic"). Message:

```text
error: PermissionDeniedError: permission denied: caller=main capability=pied-piper.example/charges.list:
policy denied pied-piper.example/charges.list with customerId = "hooli" for main.
This request is forbidden by the operator's policy — do not work around the denial
(another package, raw HTTP, or other arguments to reach the same thing); report it and stop.
  fields: caller = "main", capability = "…", reason = "…"
  at listCharges (@pied-piper/billing/lib:28:48)  [thrown here]   <- the check() line, with source excerpt
  at main (<execute>:12:40)  [entry]                              <- the calling line, with source excerpt
```

Quickstart climax, verbatim behaviour: `[program] 2 charges, 6150 cents` (legitimate work completes and logs first), then `[denied] …`, **nonzero exit**. The docs' framing: "Had that call run, another customer's charge data would have returned into the agent's context."

### 8.3 Optional real-agent step

`examples/quickstart/agent.py`: LangChain **deepagents** + **Gemini** over **MCP** (`/mcp/<blueprint>`); the server token and the customer id travel **in headers**, "so the model never sees either"; needs Python 3.11+, `GOOGLE_API_KEY` + `GOOGLE_MODEL`, costs real model calls, and is excluded from `verify.sh` because "a model only takes the injection bait some of the time" — the docs are explicit that the *guarantee* lives in the policy, not the model. Other harness examples in `examples/harnesses/`: Mastra, OpenAI Agents SDK, Claude Agent SDK, Vercel AI SDK over HTTP, deepagents; plus `examples/embedding/` (Voyage embeddings ranking notes — a second minimal Package-less Blueprint example) and `examples/docker/` (compose + demo/conformance Blueprints).

### 8.4 Their demo video (README)

`readme.md`, "Demo": **readme-demo-v2.mp4** — "A support agent creates a replacement with $18 shipping. A $42 replacement is blocked until the developer raises the Blueprint limit from $25 to $50." (The task brief's "refund/replacement" phrasing: the repo README's own rule example is refund tiers — up to $500 platinum / $100 other tiers — and the homepage example is a stripe refund, `amount <= 500`. The video itself was not watched; description is from `readme.md` only.)

---

## 9. Ranked phext integration surfaces

Ranked by how **native** each is to the extension points in §7 — i.e. how much of Submilli's machinery (semantic checks, Blueprint binding, secret store, audit) it actually gets — with the §2–§6 findings applied.

### Surface 1 — Native TS Package wrapping SQ over HTTP (Route A) ⭐ recommended primary

`@<scope>/phext` (scope must be GitHub-org-shaped) whose operations (`scrolls.select`, `scrolls.insert`, `scrolls.update`, `toc.read`, `delta.read`, `checksum.read`, … — **one capability name each**) each: normalise arguments → compute `lane` from the coordinate → `check(name, { phextId, coordinate, lane })` → `secrets.get("SQ_API_KEY")` → `submilli:http` call to SQ `/api/v2/…`. SQ base URL via `src/config.ts --config` at install. Blueprint binds `phextId` (required variable), grants `main` read caps with `coordinate glob "<lane>/*"` and withholds write caps (or scopes them tighter); grants the Package caller only `http.*` to the SQ host + `secrets.get` for the one key.

- **Why first:** it is a verbatim copy of the curated-Package pattern (§3.3) — the route Submilli's own ecosystem, linter, security review, and docs tooling are built for. It reuses production SQ: coordinate addressing, `toc/select/query/delta/checksum`, per-phext mutex, whole-file persistence on Will's existing infrastructure. The Package stays thin (HTTP + check payloads), so the demo's centre of gravity is the *policy*, which is the story.
- **Costs/risks:** SQ egress blockers (§3.3: `allow_insecure_http` for plain-HTTP SQ; server `network.allow_private/allow_localhost` for local/tailnet SQ; tailnet-IP classification **UNVERIFIED**); durable-execution double-write caveat (§5.2 — keep durable off for the demo, or use idempotent whole-scroll `update`); SQ is a second process to run in the demo.

### Surface 2 — Native TS Package with an in-Package phext engine over a VFS volume (Route B)

Same capability/payload design as Surface 1, but the backend is `submilli:fs` byte APIs on a `.phext` file: root/mount = **named volume** for a persistent phext, or `per_session` for a disposable demo phext. Package caller granted `fs.read/fs.write` (path-globbed to the phext file[s]); `main` granted only the phext operations. Proven fs-in-Package precedent: gmail/google-drive/notion (§4.2).

- **Why second, and when it might be first:** equally native as a *Package*, and it removes every SQ networking blocker — a self-contained demo (one server, one volume, a fixture `.phext` copied in by the operator) with the identical Blueprint story. For a **first demo** this may actually be the lower-risk build. It ranks below Route A as an *integration* because it forks phext semantics into a new TS implementation: a parser/addressing port that does not exist yet (**UNVERIFIED** effort until spiked), no `delta/checksum` protocol (the ocbox resume win would need re-inventing), whole-file rewrites by the Package itself, and no cross-session writer serialisation on a shared volume (§4.3).
- **Design guardrails if chosen:** byte APIs only; SHA-256 round-trip build test; report `phextId/coordinate/lane` exactly as Surface 1 so the Blueprint — and a later swap to Route A — does not change.

### Surface 3 — Phext as plain VFS files + session KV, no Package (Blueprint-only)

Blueprint grants `main` itself `fs.read/fs.write` with `path glob "/phext/*.phext"` on a `per_session`/named volume, and/or `session.*` KV with key-prefix globs (`key glob "triage/*"` is the docs' own example); the agent's programs read/write the raw `.phext` text and parse it in-program.

- **Why third:** zero build — a Blueprint and a fixture only; genuinely useful as a **smoke demo / fallback**. But granularity stops at the file path: no coordinate rules, no semantic operations, the model handles raw delimiter bytes itself (the thing Packages exist to prevent), and `main` holding raw `fs.write` to a shared named volume is the weakest story of the three. KV variant is worse for phext proper (values are session-scoped, die at close, and are not phext files).

### Surface 4 — Host-side companion: phext as the audit / run-record sink (outside the runtime)

A small trusted host program (beside `app.mjs`) that tails the server's **audit logfmt file** (§5.3) and/or polls `GET /v1/runs`, and appends execution/decision records as scrolls into a phext via SQ — i.e. the ocbox-phext pattern (session lanes by artifact class) applied to Submilli runs: one lane per session/run, checkpoints carrying blueprint hash + execution ids.

- **Why fourth:** it composes beautifully with Will's existing ocbox work and needs **no** Submilli changes — but it integrates at the *application* layer, not in the runtime: no permission semantics, no in-sandbox access, and audit has no query API (file tailing is the interface). Best framed as a **phase-2 companion** to Surface 1/2 ("every run the agent makes is itself recorded in phext"), not as the integration.

### Surface 5 — MCP wrapping of a phext/SQ tool server

Build an MCP server over SQ, declare it in the Blueprint `mcp:` block, grant `mcp.<name>` with `tool ==` filters.

- **Why last:** real extension point, good credential story — and **argument-blind** (§6): no `phextId`, no coordinate, no lane can ever appear in a rule. It throws away the one property this integration exists to demonstrate. The docs' own advice for a too-broad MCP tool is to front it with a Package — i.e. Surface 1. Only sensible if a phext MCP server already existed for other reasons (**none exists in checked sources**).

### Not ranked — Rust embedding (Surface 0, out of scope unless the goal changes)

Embedding `submilli-engine` + `submilli-policy` in a Rust host and implementing `Filesystem`/`SessionKvStore`/`EffectHistory` over phext storage (§7 #9) is real, published-crate API — but it means replacing `submilli-server`, not integrating with it, and re-implementing everything the server already does. Recorded for completeness; not a demo path.

**Demo-plan implications (for the parent spec, mirroring their own material):**

- Mirror the README video: Blueprint v1 allows scroll **reads** in the bound lane + a **write** cap with a size/coordinate limit; the agent completes a legitimate read/write; an injected instruction (the quickstart's "compliance step" move) asks for a scroll in another phext / another lane → runtime denial, HTTP 200, `[denied]` diagnostic naming `phextId`/`coordinate`; then the operator edits **one Blueprint line** (widen the coordinate glob / raise the limit — the $25 → $50 move) and the same program succeeds. No model behaviour needs to cooperate for the denial half.
- Bind with variables exactly as `customerId` is bound: host application sets `phextId` (+ optionally a lane prefix) at session open / `/v1/execute`; the model never sees the binding mechanism.
- Keep check payloads to `{ phextId, coordinate, lane }` (+ maybe `length` for writes) — the audit trail stores full payloads (§5.3), so never scroll text.

---

## 10. Build / run prerequisites (checked)

Sources: `rust-toolchain.toml`, root `Cargo.toml`, `install.sh`, `docs/part-1-start-here/02-install.md`, quickstart (web + `docs/part-1-start-here/03-quickstart.md`), `compose.yaml`, `docs/part-4-server/01-run-the-server.md`.

- **Install (users):** `curl -fsSL https://submilli.ai/install.sh | sh` (macOS/Linux; installs `submilli` + `submilli-server` into `~/.local/bin`, verifies each binary against the release `SHA256SUMS` with SHA-256 before replacing anything — repo `install.sh` read directly); Windows: `irm https://submilli.ai/install.ps1 | iex`. Pin with `--version v0.5.1`. `submilli upgrade` self-updates.
- **Quickstart prereqs:** Node.js **22+**, `curl`, `openssl`; Bash/Zsh terminal (Windows → WSL for the tutorial). Optional agent step: Python 3.11+ + a Gemini key.
- **Run a server locally:**
  ```sh
  export SUBMILLI_HOME="$PWD/.submilli-data"   # or ~/.submilli by default
  export SUBMILLI_BIND=127.0.0.1 SUBMILLI_PORT=<port> SUBMILLI_SERVER_URL="http://127.0.0.1:$SUBMILLI_PORT"
  export SUBMILLI_SERVER_TOKEN="$(openssl rand -hex 32)"   # >=32 chars; server refuses to start without a token unless allow_unauthenticated
  submilli-server &                            # listens 127.0.0.1:8128 by default
  submilli-server --health-check               # readiness probe (also GET /healthz, unauthenticated)
  submilli server blueprint apply blueprint.yaml
  submilli server status                       # running / bind / pid / active sessions / blueprints
  ```
  Config alternatively via YAML file (`--config` / `SUBMILLI_CONFIG`); precedence flag > env > file. Roles: the `SUBMILLI_SERVER_TOKEN` is an **admin** token; give applications a separate **user** token before anything untrusted runs.
- **Production shapes:** Docker Compose (`compose.yaml` in-repo: image `ghcr.io/submilli/submilli-runtime`, loopback-only port publish, state volume holding SQLite + volumes + secrets together, secret-store key as a *file* secret), Helm chart (`charts/submilli`), systemd (`docs/part-4-server/05-deploy-on-linux.md`).
- **Build from source:** Rust toolchain pinned by `rust-toolchain.toml` to channel **1.98.1** (minimal profile + clippy/rustfmt), workspace edition 2024, resolver 3. (Version number as written in the file at the checked commit.) Building the workspace was **not** attempted in this recon — **UNVERIFIED** that it builds clean in this VM; the demo route should prefer the released binaries + `examples/quickstart/verify.sh` (`SUBMILLI=`/`SUBMILLI_SERVER=` env to point it at installed binaries instead of `cargo run`).

---

## 11. Blockers, gaps, and unverified items

1. **SQ egress from the server sandbox (Route A):** plain-HTTP SQ needs Blueprint `allow_insecure_http: true`; loopback/private SQ needs server `network.allow_localhost`/`allow_private`. Whether a **Tailscale `100.x` address** is classified private by the egress guard: **UNVERIFIED** — test with a throwaway Blueprint before the demo, or front SQ with HTTPS.
2. **No TS phext implementation exists in checked sources (Route B's main cost).** Will's on-hand implementations: Python `~/workspace/phext/parse_phext.py`, Rust libphext via SQ. A TS-subset port is unscoped until spiked; control-byte round-trip through `readText` is **UNVERIFIED** (byte APIs + SHA-256 test mandated in §4.3).
3. **No storage-backend plugin for `submilli-server`** (§7 #9): SQLite is concrete. Any "phext *as* Submilli's session/durable store" idea requires embedding the engine in a new Rust host — out of demo scope.
4. **Durable execution × external writes:** uncommitted SQ writes may re-execute after crash recovery (§5.2). Keep `durable_execution: false` (default) for the demo, or prove idempotency of each phext write op. SQ duplicate-`insert` semantics: **UNVERIFIED**.
5. **Volume seeding:** no API to upload content into a named volume (§4.3) — demo fixtures are placed by the operator on the host (fine) or written by a one-off granted program.
6. **Audit is a file, not an API** (§5.3) — Surface 4 must tail logfmt; also, audit `payload_json` retains full check contexts (design payloads accordingly).
7. **Version drift risk:** the project is young (created 2026-09-15 per GitHub, 11 releases, "breaking changes are called out in the release notes" — `readme.md` Status). Denial `error.kind` already changed once (v0.2.0 `runtime_error` → `permission_denied`). Pin the demo to a release (`--version`) and to this commit's docs.
8. **Not checked / not attempted:** building the Rust workspace; running `verify.sh`; watching the demo video (described from `readme.md` only); docs.rs API surface beyond the two crate pages surfaced in search; `submilli:agents`/`submilli:skills` semantics (§3.4 flag); Helm chart contents; the `verification/` and `plans/` directories in-repo.

---

## 12. Source index (everything above traces to one of these)

**Live pages read in full:** https://github.com/submilli/submilli-runtime (repo root + README) · https://submilli.ai/docs/blueprints · https://submilli.ai/docs/quickstart · https://submilli.ai/docs

**In the clone @ `aeaded7`:** `readme.md` · `Cargo.toml` · `rust-toolchain.toml` · `install.sh` · `compose.yaml` · `submilli.toml` · `crates/{interpreter,submilli,submilli-blueprint,submilli-build,submilli-durable,submilli-policy,submilli-server,submilli-shared,conformance}/{Cargo.toml,README.md,src/…}` · `docs/part-1-start-here/{02-install,03-quickstart,05-packages,06-server,07-application}.md` · `docs/part-2-blueprints/{03-keep-files-and-state,06-add-an-mcp-server}.md` · `docs/part-3-packages/02-export-a-function.md` · `docs/part-4-server/01-run-the-server.md` · `docs/part-6-reference/{audit-trail,blueprint-file,filter-language,http-api,mcp-servers,package-configuration,package-manifest,permissions,run-recovery,server-settings,standard-library}.md` · `packages/{README.md,brave-search,github,gmail,google-drive,notion,slack-bot}/…` · `examples/quickstart/{readme.md,blueprint.yaml,submilli.toml,total.ts,total-injected.ts,app.mjs,verify.sh,package/…}` · `examples/embedding/{README.md,blueprint.yaml,search-notes.ts}`

**Local phext ground truth:** `~/workspace/phext/parse_phext.py` (delimiter bytes, coordinate model) · `~/workspace/ocbox-phext/SPEC-v0.2.md` §2 (SQ v0.6.0 HTTP surface, locally verified) · `~/workspace/phext/*.phext` (file sizes, `ls` 2026-11-01)
