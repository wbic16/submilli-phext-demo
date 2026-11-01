import { label } from "submilli:test";
import { read, write } from "submilli:fs";
import { sha256 } from "submilli:crypto";
import { toc, readScroll, writeScroll, checksum } from "@wbic16/phext";
import { parsePhext, serializePhext, laneOf } from "../src/phext";

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

    label("fs byte APIs preserve a phext file byte-exact");
    write("/fixture.phext", fixture);
    const back = read("/fixture.phext");
    assert(back !== undefined, "read back returned undefined");
    if (back !== undefined) {
        assert(back.equals(fixture), "fs round-trip bytes differ");
        assert(sha256(back).toHex() === sha256(fixture).toHex(),
            "sha256 after fs round-trip differs");
        const again = serializePhext(parsePhext(back));
        assert(again.equals(fixture), "parse/serialise after fs round-trip differs");
    }

    label("package ops write and read scrolls by coordinate");
    writeScroll("demo", "1.1.1/1.1.1/1.1.1", "handbook");
    writeScroll("demo", "1.1.1/1.2.1/1.1.1", "session note");
    assert(readScroll("demo", "1.1.1/1.1.1/1.1.1") === "handbook", "reference scroll reads back");
    assert(readScroll("demo", "1.1.1/1.2.1/1.1.1") === "session note", "session scroll reads back");
    const coords = toc("demo");
    assert(coords.length === 2 && coords[1] === "1.1.1/1.2.1/1.1.1",
        "toc lists both coordinates in order, got " + coords.join(","));
    const raw = read("/phext/demo.phext");
    assert(raw !== undefined && checksum("demo") === sha256(raw).toHex(),
        "checksum op matches sha256 of the file on disk");

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

    label("package ops insert a scroll between existing entries");
    // The demo fixture's shape: the session lane precedes the other-session
    // lane in file order, so a new findings scroll must land mid-file.
    writeScroll("demo2", "1.1.1/1.1.1/1.1.1", "handbook text");
    writeScroll("demo2", "1.1.1/1.2.1/1.1.1", "session seed");
    writeScroll("demo2", "1.1.1/1.3.1/1.1.1", "other session notes");
    writeScroll("demo2", "1.1.1/1.2.1/1.1.2", "findings");
    const order = toc("demo2");
    const expected: string[] = [
        "1.1.1/1.1.1/1.1.1", "1.1.1/1.2.1/1.1.1",
        "1.1.1/1.2.1/1.1.2", "1.1.1/1.3.1/1.1.1",
    ];
    assert(order.length === expected.length,
        "toc after mid-insert has " + expected.length + " entries, got " + order.join(","));
    for (let i = 0; i < expected.length; i++) {
        assert(order[i] === expected[i],
            "toc entry " + i + ": expected " + expected[i] + ", got " + order[i]);
    }
    assert(readScroll("demo2", "1.1.1/1.2.1/1.1.2") === "findings", "inserted scroll reads back");
    assert(readScroll("demo2", "1.1.1/1.1.1/1.1.1") === "handbook text",
        "scroll before the insertion is untouched");
    assert(readScroll("demo2", "1.1.1/1.3.1/1.1.1") === "other session notes",
        "scroll after the insertion is untouched");
    // Re-parse the file on disk: coordinates must survive the byte format,
    // not just the in-memory entry list.
    const raw2 = read("/phext/demo2.phext");
    assert(raw2 !== undefined, "demo2 file exists on disk");
    if (raw2 !== undefined) {
        const reparsed = parsePhext(raw2);
        assert(reparsed.length === expected.length,
            "re-parsed file has " + expected.length + " entries, got " + reparsed.length);
        for (let i = 0; i < expected.length; i++) {
            assert(reparsed[i].coordinate === expected[i],
                "re-parsed entry " + i + ": expected " + expected[i] + ", got " + reparsed[i].coordinate);
        }
        assert(serializePhext(reparsed).equals(raw2),
            "re-parsed file round-trips byte-exact after mid-insert");
    }
}
