// Used only under blueprint-raised.yaml, which adds a main rule allowing
// scrolls.write in the reference lane. Replaces the handbook scroll with
// the V2 text and reads it back.
import { readScroll, writeScroll } from "@wbic16/phext";

function main(): string {
    const updated =
        "HANDBOOK-TRIAGE-V2 Support triage protocol. " +
        "Step one: identify the customer and the failing service. " +
        "Step two: check recent changes before escalating. " +
        "Step three: record your findings in your own session lane. " +
        "(Revised under the raised Blueprint.)";
    writeScroll("demo", "1.1.1/1.1.1/1.1.1", updated);
    const back = readScroll("demo", "1.1.1/1.1.1/1.1.1");
    if (back !== updated) {
        throw new Error("handbook read-back differs from what was written");
    }
    const words = back.split(" ");
    return "handbook updated at 1.1.1/1.1.1/1.1.1 first-words=" +
        words[0] + " " + words[1] + " " + words[2];
}
