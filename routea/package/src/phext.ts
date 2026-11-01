/**
 * Phext engine for @wbic16/phext, ported from the dead-reckoning
 * byte-walk in ~/workspace/phext/parse_phext.py.
 *
 * Delimiter hierarchy (highest -> lowest):
 *   0x01 Library, 0x1F Shelf, 0x1E Series, 0x1D Collection, 0x1C Volume,
 *   0x1A Book, 0x19 Chapter, 0x18 Section, 0x17 Scroll
 * Hitting a delimiter increments that level and resets all lower levels to 1.
 * Coordinates are 1-indexed; the first scroll sits at 1.1.1/1.1.1/1.1.1.
 *
 * Parse keeps, for each entry, the delimiter byte that preceded it, so
 * serialise can reproduce the input byte-for-byte (asserted by the tests).
 */

export const DELIMITERS: number[] = [0x01, 0x1f, 0x1e, 0x1d, 0x1c, 0x1a, 0x19, 0x18, 0x17];

export interface PhextEntry {
    /** Canonical coordinate string, e.g. "1.1.1/1.1.1/1.1.2". */
    coordinate: string;
    /** Delimiter byte that preceded this entry, or -1 for the first entry. */
    delimBefore: number;
    /** Raw scroll bytes (never decoded by the engine). */
    content: Uint8Array;
}

function levelOf(byte: number): number {
    for (let i = 0; i < DELIMITERS.length; i++) {
        if (DELIMITERS[i] === byte) {
            return i;
        }
    }
    return -1;
}

export function formatCoordinate(coord: number[]): string {
    return (
        coord[0] + "." + coord[1] + "." + coord[2] + "/" +
        coord[3] + "." + coord[4] + "." + coord[5] + "/" +
        coord[6] + "." + coord[7] + "." + coord[8]
    );
}

export function parseCoordinate(coordinate: string): number[] {
    const groups = coordinate.split("/");
    const out: number[] = [];
    for (const group of groups) {
        for (const part of group.split(".")) {
            out.push(parseInt(part, 10));
        }
    }
    return out;
}

/**
 * The lane of a coordinate: its first two groups, e.g. "1.1.1/1.2.1".
 * @param coordinate The canonical coordinate string.
 * @returns The lane prefix.
 */
export function laneOf(coordinate: string): string {
    const first = coordinate.indexOf("/");
    if (first < 0) {
        return coordinate;
    }
    const second = coordinate.indexOf("/", first + 1);
    if (second < 0) {
        return coordinate;
    }
    return coordinate.substring(0, second);
}

export function parsePhext(data: Uint8Array): PhextEntry[] {
    const entries: PhextEntry[] = [];
    const coord: number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    let buf: number[] = [];
    let pendingDelim = -1;
    for (let i = 0; i < data.length; i++) {
        const b = data[i];
        const lvl = levelOf(b);
        if (lvl < 0) {
            buf.push(b);
        } else {
            entries.push({
                coordinate: formatCoordinate(coord),
                delimBefore: pendingDelim,
                content: Uint8Array.fromArray(buf),
            });
            buf = [];
            coord[lvl] += 1;
            for (let j = lvl + 1; j < 9; j++) {
                coord[j] = 1;
            }
            pendingDelim = b;
        }
    }
    entries.push({
        coordinate: formatCoordinate(coord),
        delimBefore: pendingDelim,
        content: Uint8Array.fromArray(buf),
    });
    // Mirror parse_phext.py: drop a trailing empty scroll (the artefact of a
    // final delimiter, or of empty input); keep interior empties.
    if (entries.length > 0 && entries[entries.length - 1].content.length === 0) {
        entries.pop();
    }
    return entries;
}

export function serializePhext(entries: PhextEntry[]): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (i > 0) {
            out.push(entry.delimBefore >= 0 ? entry.delimBefore : 0x17);
        }
        for (let j = 0; j < entry.content.length; j++) {
            out.push(entry.content[j]);
        }
    }
    return Uint8Array.fromArray(out);
}

export function findScroll(entries: PhextEntry[], coordinate: string): Uint8Array | undefined {
    for (const entry of entries) {
        if (entry.coordinate === coordinate) {
            return entry.content;
        }
    }
    return undefined;
}

function compareCoords(a: number[], b: number[]): number {
    for (let i = 0; i < 9; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return 0;
}

/**
 * Re-derive `delimBefore` for a coordinate-sorted entry list, inserting
 * empty intermediate scrolls wherever consecutive entries are more than
 * one delimiter-step apart. Consecutive entries produced by parsePhext
 * always differ by exactly one step, so this walk reproduces the original
 * delimiters of untouched entries exactly; it is what makes insertion
 * *between* existing entries possible (Stage 1: the session lane precedes
 * the other-session lane in the demo fixture, so a findings scroll at
 * 1.1.1/1.2.1/1.1.2 must be inserted mid-file, not appended).
 * @param entries Sorted entries, mutated in place.
 */
function rebuildDelimiters(entries: PhextEntry[]): void {
    if (entries.length === 0) {
        return;
    }
    const out: PhextEntry[] = [];
    entries[0].delimBefore = -1;
    out.push(entries[0]);
    let current = parseCoordinate(entries[0].coordinate);
    for (let k = 1; k < entries.length; k++) {
        const targetEntry = entries[k];
        const target = parseCoordinate(targetEntry.coordinate);
        for (let step = 0; step < 100000; step++) {
            let lvl = -1;
            for (let i = 0; i < 9; i++) {
                if (current[i] !== target[i]) {
                    lvl = i;
                    break;
                }
            }
            if (lvl < 0) {
                break; // already at the target coordinate
            }
            if (current[lvl] > target[lvl]) {
                throw new Error("cannot serialise: entries out of order at " + targetEntry.coordinate);
            }
            const next: number[] = current.slice();
            next[lvl] += 1;
            for (let j = lvl + 1; j < 9; j++) {
                next[j] = 1;
            }
            if (formatCoordinate(next) === targetEntry.coordinate) {
                targetEntry.delimBefore = DELIMITERS[lvl];
                out.push(targetEntry);
                current = next;
                break;
            }
            out.push({
                coordinate: formatCoordinate(next),
                delimBefore: DELIMITERS[lvl],
                content: Uint8Array.alloc(0),
            });
            current = next;
        }
    }
    entries.length = 0;
    for (const entry of out) {
        entries.push(entry);
    }
}

/**
 * Insert-or-replace a scroll. Replacing keeps the entry's position and its
 * preceding delimiter. Inserting places the new entry at its sorted
 * position — at the end, or between existing entries — and re-derives the
 * delimiter chain (see rebuildDelimiters), creating empty intermediate
 * scrolls exactly as the byte format implies.
 * @param entries The parsed entries, mutated in place.
 * @param coordinate The target coordinate.
 * @param content The scroll's new raw bytes.
 * @returns The same entries array, updated.
 */
export function upsertScroll(entries: PhextEntry[], coordinate: string, content: Uint8Array): PhextEntry[] {
    for (const entry of entries) {
        if (entry.coordinate === coordinate) {
            entry.content = content;
            return entries;
        }
    }
    if (entries.length === 0) {
        entries.push({ coordinate: coordinate, delimBefore: -1, content: content });
        return entries;
    }
    const target = parseCoordinate(coordinate);
    let idx = entries.length;
    for (let i = 0; i < entries.length; i++) {
        if (compareCoords(parseCoordinate(entries[i].coordinate), target) > 0) {
            idx = i;
            break;
        }
    }
    const merged: PhextEntry[] = [];
    for (let i = 0; i < idx; i++) {
        merged.push(entries[i]);
    }
    merged.push({ coordinate: coordinate, delimBefore: -1, content: content });
    for (let i = idx; i < entries.length; i++) {
        merged.push(entries[i]);
    }
    entries.length = 0;
    for (const entry of merged) {
        entries.push(entry);
    }
    rebuildDelimiters(entries);
    return entries;
}
