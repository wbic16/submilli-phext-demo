// @wbic16/phext: phext scroll storage on the Submilli VFS, byte APIs only.
// One file per phextId, at /phext/<phextId>.phext.

import { check } from "submilli:security";
import { read, write, mkdir, exists } from "submilli:fs";
import { sha256 } from "submilli:crypto";
import {
    PhextEntry,
    findScroll,
    laneOf,
    parsePhext,
    serializePhext,
    upsertScroll,
} from "./phext";

function pathFor(phextId: string): string {
    return "/phext/" + phextId + ".phext";
}

// The package owns its directory: a caller's mkdir does not land in the
// package's filesystem view (observed in the Stage-0 spike tests), and
// read() throws when the parent directory does not exist.
function ensureDir(): void {
    if (!exists("/phext")) {
        mkdir("/phext", true);
    }
}

function loadEntries(phextId: string): PhextEntry[] {
    ensureDir();
    // Spike finding: read() throws "parent directory does not exist" for a
    // missing file in a not-yet-materialised directory instead of returning
    // undefined, so existence is checked first.
    if (!exists(pathFor(phextId))) {
        return [];
    }
    const data = read(pathFor(phextId));
    if (data === undefined) {
        return [];
    }
    return parsePhext(data);
}

function saveEntries(phextId: string, entries: PhextEntry[]): void {
    write(pathFor(phextId), serializePhext(entries));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    const found = findScroll(loadEntries(phextId), coordinate);
    if (found === undefined) {
        throw new Error("no scroll at " + coordinate + " in phext " + phextId);
    }
    return decoder.decode(found);
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
    const bytes = encoder.encode(text);
    const length = bytes.length;
    check("phext.example/scrolls.write", { phextId, coordinate, lane, length });
    const entries = upsertScroll(loadEntries(phextId), coordinate, bytes);
    saveEntries(phextId, entries);
}

/**
 * SHA-256 of the phext file's raw bytes, as hex.
 * @param phextId The phext's identifier, bound by the application.
 * @returns The hex digest; the empty-file digest when the phext is absent.
 * @capability phext.example/checksum.read { phextId: string }
 */
export function checksum(phextId: string): string {
    check("phext.example/checksum.read", { phextId });
    ensureDir();
    if (!exists(pathFor(phextId))) {
        return sha256(Uint8Array.alloc(0)).toHex();
    }
    const data = read(pathFor(phextId));
    if (data === undefined) {
        return sha256(Uint8Array.alloc(0)).toHex();
    }
    return sha256(data).toHex();
}

