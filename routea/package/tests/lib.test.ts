import { label } from "submilli:test";
import { sha256 } from "submilli:crypto";
import {
    parsePhext,
    serializePhext,
    laneOf,
    upsertScroll,
    findScroll,
} from "../src/phext";

// Route A package tests cover the pure phext engine only. The four
// operations themselves talk to a live SQ server over HTTP with a
// runtime-held secret; they are exercised end-to-end by
// ../../verify-routea.sh, not here (a build test has no SQ to call).

// Fixture: scrolls separated by ALL nine delimiter classes, built byte by
// byte. Coordinates below follow parse_phext.py dead reckoning.
function pushText(bytes: number[], text: string): void {
    const enc = new TextEncoder().encode(text);
    for (let i = 0; i < enc.length; i++) {
        bytes.push(enc[i]);
    }
}

function buildFixture(): Uint8Array {
    const b: number[] = [];
    pushText(b, "alpha");            // 1.1.1/1.1.1/1.1.1
    b.push(0x17);                    // scroll
    pushText(b, "beta");             // 1.1.1/1.1.1/1.1.2
    b.push(0x18);                    // section
    pushText(b, "gamma");            // 1.1.1/1.1.1/1.2.1
    b.push(0x19);                    // chapter
    pushText(b, "delta");            // 1.1.1/1.1.1/2.1.1
    b.push(0x1a);                    // book
    pushText(b, "epsilon");          // 1.1.1/1.1.2/1.1.1
    b.push(0x1c);                    // volume
    pushText(b, "zeta");             // 1.1.1/1.2.1/1.1.1
    b.push(0x1d);                    // collection
    pushText(b, "eta");              // 1.1.1/2.1.1/1.1.1
    b.push(0x1e);                    // series
    pushText(b, "theta");            // 1.1.2/1.1.1/1.1.1
    b.push(0x1f);                    // shelf
    pushText(b, "iota");             // 1.2.1/1.1.1/1.1.1
    b.push(0x01);                    // library
    pushText(b, "kappa");            // 2.1.1/1.1.1/1.1.1
    b.push(0x17);                    // scroll -> interior empty scroll
    // (empty)                       // 2.1.1/1.1.1/1.1.2
    b.push(0x17);                    // scroll
    pushText(b, "lambda");           // 2.1.1/1.1.1/1.1.3
    return Uint8Array.fromArray(b);
}

const EXPECTED_COORDS: string[] = [
    "1.1.1/1.1.1/1.1.1", "1.1.1/1.1.1/1.1.2", "1.1.1/1.1.1/1.2.1",
    "1.1.1/1.1.1/2.1.1", "1.1.1/1.1.2/1.1.1", "1.1.1/1.2.1/1.1.1",
    "1.1.1/2.1.1/1.1.1", "1.1.2/1.1.1/1.1.1", "1.2.1/1.1.1/1.1.1",
    "2.1.1/1.1.1/1.1.1", "2.1.1/1.1.1/1.1.2", "2.1.1/1.1.1/1.1.3",
];

function textOf(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function main(): void {
    const fixture = buildFixture();

    label("engine parses all nine delimiter classes to the expected coordinates");
    const entries = parsePhext(fixture);
    assert(entries.length === EXPECTED_COORDS.length,
        "expected " + EXPECTED_COORDS.length + " entries, got " + entries.length);
    for (let i = 0; i < EXPECTED_COORDS.length; i++) {
        assert(entries[i].coordinate === EXPECTED_COORDS[i],
            "entry " + i + ": expected " + EXPECTED_COORDS[i] + ", got " + entries[i].coordinate);
    }
    assert(entries[10].content.length === 0, "interior empty scroll is kept");
    assert(laneOf("1.1.1/1.2.1/1.1.1") === "1.1.1/1.2.1", "lane is the first two groups");

    label("engine round-trips byte-exact, sha256 equal");
    const reserialised = serializePhext(entries);
    assert(reserialised.equals(fixture), "re-serialised bytes differ from the fixture");
    assert(sha256(reserialised).toHex() === sha256(fixture).toHex(),
        "sha256 of re-serialised bytes differs from the fixture hash");

    label("lane derivation boundary cases");
    assert(laneOf("1.1.1/1.1.1/1.1.1") === "1.1.1/1.1.1", "origin lane");
    assert(laneOf("1.1.1/1.2.1/1.1.9") === "1.1.1/1.2.1",
        "scroll component never affects the lane");
    assert(laneOf("1.1.1/1.2.1/9.9.9") === "1.1.1/1.2.1",
        "whole third group never affects the lane");
    assert(laneOf("1.1.1/1.3.1/2.4.5") === "1.1.1/1.3.1", "third lane");
    assert(laneOf("1.1.1/1.2.2/1.1.1") === "1.1.1/1.2.2",
        "book component is part of the lane: 1.2.2 is a different lane from 1.2.1");
    assert(laneOf("2.1.1/1.1.1/1.1.1") === "2.1.1/1.1.1",
        "library component is part of the lane");
    assert(laneOf("1.1.1/1.2.1/1.1.1") !== laneOf("1.1.1/1.3.1/1.1.1"),
        "session lane and other-session lane differ");

    label("engine inserts a scroll between existing entries, byte-exact on reparse");
    const doc = parsePhext(fixture);
    const trimmed = [doc[0], doc[5], doc[6]]; // 1.1.1/1.1.1/1.1.1, 1.1.1/1.2.1/1.1.1, 1.1.1/2.1.1/1.1.1
    upsertScroll(trimmed, "1.1.1/1.2.1/1.1.2", new TextEncoder().encode("findings"));
    const bytes = serializePhext(trimmed);
    const reparsed = parsePhext(bytes);
    const coords: string[] = [];
    for (const e of reparsed) {
        coords.push(e.coordinate);
    }
    assert(coords.join(",") === "1.1.1/1.1.1/1.1.1,1.1.1/1.2.1/1.1.1,1.1.1/1.2.1/1.1.2,1.1.1/2.1.1/1.1.1",
        "mid-insert order wrong: " + coords.join(","));
    const found = findScroll(reparsed, "1.1.1/1.2.1/1.1.2");
    assert(found !== undefined && textOf(found) === "findings", "inserted scroll reads back");
    assert(serializePhext(reparsed).equals(bytes), "reparse round-trips byte-exact after insert");
}
