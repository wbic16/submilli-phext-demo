// The demo application. Ordinary Node.js, outside Submilli, written once.
//
// It binds the session's trusted context — phextId "demo" and lane
// "1.1.1/1.2.1" — the way the quickstart binds customerId: from the
// application's own knowledge, never from the program. The agent's
// program never sees the binding and cannot change it.
//
// Modes:
//   node app.mjs PROGRAM.ts              one-off run (POST /v1/execute)
//   node app.mjs --open-session          open a session, print its id
//   node app.mjs --session ID PROGRAM.ts run PROGRAM inside that session
// Any mode also accepts --blueprint NAME (default phext-demo); Stage 2's
// persistence flow opens its sessions with --blueprint phext-demo-persistent.
//
// The one-off mode is the quickstart shape. The session mode exists
// because the demo seeds the session's per-session filesystem with the
// fixture phext before running programs (see README / verify.sh).
import { readFileSync } from "node:fs";

const SUBMILLI_SERVER = (process.env.SUBMILLI_SERVER_URL || "http://127.0.0.1:8128").replace(/\/$/, "");
let BLUEPRINT_NAME = "phext-demo";

// Bound once per session/request by the application, never by the program.
const variables = { phextId: "demo", lane: "1.1.1/1.2.1" };

const token = process.env.SUBMILLI_SERVER_TOKEN;
if (!token) {
  fail("error: SUBMILLI_SERVER_TOKEN is not set; export the token the server was started with.");
}

const args = process.argv.slice(2);

// --blueprint NAME may appear anywhere; it selects which registered
// blueprint a session is opened under (or a one-off run uses).
for (let i = args.length - 2; i >= 0; i--) {
  if (args[i] === "--blueprint") {
    BLUEPRINT_NAME = args[i + 1];
    args.splice(i, 2);
  }
}

if (args[0] === "--open-session") {
  const response = await call("/v1/sessions", { blueprint: BLUEPRINT_NAME, variables });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    fail(`[server error] ${body.message || body.error || `HTTP ${response.status}`}`);
  }
  const body = await response.json();
  if (!body.session_id) fail("error: server did not return a session_id");
  console.log(`[session] ${body.session_id}`);
  process.exit(0);
}

let sessionId = null;
let programPath = null;
if (args[0] === "--session") {
  sessionId = args[1];
  programPath = args[2];
  if (!sessionId || !programPath) {
    fail("usage: node app.mjs --session SESSION_ID PATH_TO_TYPESCRIPT_PROGRAM");
  }
} else {
  programPath = args[0];
  if (!programPath) {
    fail("usage: node app.mjs PATH_TO_TYPESCRIPT_PROGRAM | node app.mjs --session ID PROGRAM | node app.mjs --open-session");
  }
}

let code;
try {
  code = readFileSync(programPath, "utf8");
} catch (error) {
  fail(`error: cannot read ${programPath}: ${error.message}`);
}

const response = sessionId
  ? await call(`/v1/sessions/${sessionId}/execute`, { code })
  : await call("/v1/execute", { blueprint: BLUEPRINT_NAME, code, variables });

let body;
try {
  body = await response.json();
} catch (error) {
  fail(`error: submilli-server returned invalid JSON (HTTP ${response.status}): ${error.message}`);
}

if (!body || typeof body !== "object") fail("error: invalid response from submilli-server");
const message = body.message || body.error?.message || body.error || `HTTP ${response.status}`;
if (!response.ok) {
  if (response.status === 401 || response.status === 403) fail(`[refused] ${message}`);
  if (body.error === "invalid_request" || body.error?.kind === "invalid_request") {
    fail(`[invalid_request] ${message}`);
  }
  fail(`[server error] ${message}`);
}

let consoleLines = body.console ?? [];
if (sessionId) {
  // v0.5.1 quirk: the session execute response carries console: [] — the
  // run's console lines are on the session's last-run record instead.
  try {
    const lr = await fetch(`${SUBMILLI_SERVER}/v1/sessions/${sessionId}/last-run`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (lr.ok) {
      const lrBody = await lr.json();
      if (Array.isArray(lrBody.console)) consoleLines = lrBody.console;
    }
  } catch { /* keep whatever the execute response carried */ }
}
for (const line of consoleLines) console.log(`[program] ${line}`);
if (body.error?.kind === "invalid_request") {
  fail(`[invalid_request] ${body.error.message}`);
}
// Released v0.2.0 reports policy denials as runtime_error with this diagnostic.
const isPolicyDenial = body.error?.kind === "permission_denied" ||
  (body.error?.kind === "runtime_error" && body.error.message?.startsWith("error: PermissionDeniedError: permission denied:"));
if (isPolicyDenial) {
  console.error(`[denied]  ${body.error.message}`);
  process.exit(1);
}
if (body.error) fail(`[error] ${body.error.kind}: ${body.error.message}`);
console.log(`[result]  ${body.result}`);

async function call(path, payload) {
  try {
    return await fetch(`${SUBMILLI_SERVER}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    fail(`error: cannot reach submilli-server at ${SUBMILLI_SERVER}: ${error.message}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
