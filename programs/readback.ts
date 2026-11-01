// Act 6 read-back: a NEW session, after a server restart, reads what a
// previous session wrote — the phext lives on the named volume, not in
// any session's own filesystem. Read-only: this program writes nothing.
import { readScroll, checksum } from "@wbic16/phext";

function main(): string {
    const findings = readScroll("demo", "1.1.1/1.2.1/1.1.2");
    const sum = checksum("demo");
    console.log("readback findings at 1.1.1/1.2.1/1.1.2: " + findings);

    return "findings=" + findings + " checksum=" + sum;
}
