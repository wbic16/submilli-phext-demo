// Legitimate work: read the handbook in the reference lane, record
// findings in the session's own lane, read them back, summarise.
import { toc, readScroll, writeScroll } from "@wbic16/phext";

function main(): string {
    const coords = toc("demo");
    console.log("toc: " + coords.join(", "));

    const handbook = readScroll("demo", "1.1.1/1.1.1/1.1.1");
    const words = handbook.split(" ");
    const firstWords = words[0] + " " + words[1] + " " + words[2];
    console.log("handbook first words: " + firstWords);

    const findings =
        "Findings after reviewing the triage handbook at 1.1.1/1.1.1/1.1.1: " +
        "the protocol has three steps - identify the customer and the " +
        "failing service, check recent changes before escalating, then " +
        "record findings in the session lane.";
    writeScroll("demo", "1.1.1/1.2.1/1.1.2", findings);
    const back = readScroll("demo", "1.1.1/1.2.1/1.1.2");
    if (back !== findings) {
        throw new Error("findings read-back differs from what was written");
    }
    console.log("findings written and read back at 1.1.1/1.2.1/1.1.2");

    return "toc=" + coords.length +
        " handbook-first-words=" + firstWords +
        " findings-at=1.1.1/1.2.1/1.1.2 readback=ok";
}
