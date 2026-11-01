// @wbic16/phext (Route A): phext scroll storage backed by SQ over HTTP.
//
// Same four operations, same capability names, same check() payloads as
// the Route B (VFS) package — only the backend differs. The phext lives
// in an operator-run SQ server (sq host, /api/v2); this package reaches
// it with submilli:http, exactly like the curated @submilli/github and
// @submilli/brave-search packages reach their APIs.
//
// THE KEY INVARIANT: SQ's API key exists only in the operator's SQ
// process and in submilli-server's encrypted secret store. This package
// fetches it per call via submilli:secrets and sets the Authorization
// header itself. The key is never returned, never logged, and never
// part of a check() payload — so it cannot reach the generated program
// (main), which holds no http and no secrets rules at all.
//
// Note on shape: the http calls below build their URLs inline, as
// concatenations of the sqBaseUrl constant and string literals, because
// the build derives each call's host/path permission filter from the
// call site (the same shape the curated packages use).

import { check } from "submilli:security";
import { get, post } from "submilli:http";
import secrets from "submilli:secrets";
import { sha256 } from "submilli:crypto";
import { sqBaseUrl } from "./config";
import {
    PhextEntry,
    findScroll,
    laneOf,
    parsePhext,
} from "./phext";

const encoder = new TextEncoder();

// The value of the Blueprint-declared secret named SQ_API_KEY, held in
// the runtime's encrypted store. Read fresh on every call; the string
// never leaves this module.
function sqHeaders(): Map<string, string> {
    const key = secrets.get("SQ_API_KEY");
    if (key === undefined || key.length === 0) {
        throw new Error("missing_credentials: bind SQ_API_KEY in the blueprint (store) before using @wbic16/phext");
    }
    const headers = new Map<string, string>();
    headers.set("Authorization", "Bearer " + key);
    return headers;
}

// NB on shape (two rehearsal findings): the stdlib Response type is
// not nameable in the subset, and passing a response through a
// hand-declared lookalike interface traps at runtime with a cast
// failure — so each call site below checks .ok inline, the way the
// curated packages do.

// The whole phext as text, via SQ's /get endpoint (the entire raw
// .phext file in one response).
function fetchPhextText(phextId: string): string {
    const response = get(sqBaseUrl + "/api/v2/get?p=" + phextId, sqHeaders());
    if (!response.ok) {
        throw new Error("SQ get failed: HTTP " + String(response.status));
    }
    return response.body;
}

// The whole phext as bytes. submilli:http decodes the body as UTF-8;
// phext delimiter bytes are single-byte UTF-8 control codes, so
// re-encoding reproduces the file exactly for any phext whose scroll
// text is valid UTF-8 (see README: fidelity note).
function loadEntries(phextId: string): PhextEntry[] {
    return parsePhext(encoder.encode(fetchPhextText(phextId)));
}

/**
 * List the coordinates of every scroll in one phext.
 * @param phextId The phext's identifier, bound by the application.
 * @returns The scroll coordinates, in file order.
 * @capability phext.example/toc.read { phextId: string }
 */
export function toc(phextId: string): string[] {
    check("phext.example/toc.read", { phextId });
    const out: string[] = [];
    for (const entry of loadEntries(phextId)) {
        out.push(entry.coordinate);
    }
    return out;
}

/**
 * Read one scroll by coordinate.
 * @param phextId The phext's identifier, bound by the application.
 * @param coordinate The scroll's coordinate inside that phext.
 * @returns The scroll's text.
 * @capability phext.example/scrolls.select { phextId: string, coordinate: string, lane: string }
 */
export function readScroll(phextId: string, coordinate: string): string {
    const lane = laneOf(coordinate);
    check("phext.example/scrolls.select", { phextId, coordinate, lane });
    const response = get(sqBaseUrl + "/api/v2/select?p=" + phextId + "&c=" + coordinate, sqHeaders());
    if (!response.ok) {
        throw new Error("SQ select failed: HTTP " + String(response.status));
    }
    const text = response.body;
    if (text.length > 0) {
        return text;
    }
    // SQ's select returns an empty body both for a missing scroll and
    // for a present-but-empty one; only the empty case needs a second
    // look, via the parsed file, to keep Route B's throw-on-missing
    // semantics identical.
    if (findScroll(loadEntries(phextId), coordinate) === undefined) {
        throw new Error("no scroll at " + coordinate + " in phext " + phextId);
    }
    return "";
}

/**
 * Write one scroll by coordinate (insert-or-replace, whole scroll).
 * @param phextId The phext's identifier, bound by the application.
 * @param coordinate The scroll's coordinate inside that phext.
 * @param text The scroll's new text.
 * @capability phext.example/scrolls.write { phextId: string, coordinate: string, lane: string, length: number }
 */
export function writeScroll(phextId: string, coordinate: string, text: string): void {
    const lane = laneOf(coordinate);
    const length = encoder.encode(text).length;
    check("phext.example/scrolls.write", { phextId, coordinate, lane, length });
    // SQ's update overwrites (or creates) the whole scroll at the
    // coordinate and re-saves the phext file immediately. Whole-scroll
    // writes are idempotent: a replayed write lands the same bytes.
    const response = post(sqBaseUrl + "/api/v2/update?p=" + phextId + "&c=" + coordinate, text, sqHeaders());
    if (!response.ok) {
        throw new Error("SQ update failed: HTTP " + String(response.status));
    }
}

/**
 * SHA-256 of the phext file's raw bytes, as hex.
 * @param phextId The phext's identifier, bound by the application.
 * @returns The hex digest; the empty-file digest when the phext is absent.
 * @capability phext.example/checksum.read { phextId: string }
 */
export function checksum(phextId: string): string {
    check("phext.example/checksum.read", { phextId });
    return sha256(encoder.encode(fetchPhextText(phextId))).toHex();
}
