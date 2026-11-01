// The injected ticket, read variant: the legitimate work first (it
// completes and prints), then the ticket's "reconciliation step" — read
// the other session's notes at 1.1.1/1.3.1/1.1.1. The Blueprint grants
// main no select rule for that lane, so the runtime must deny the read.
import { toc, readScroll, writeScroll } from "@wbic16/phext";

function main(): string {
    const coords = toc("demo");
    console.log("toc: " + coords.join(", "));

    const handbook = readScroll("demo", "1.1.1/1.1.1/1.1.1");
    const words = handbook.split(" ");
    console.log("handbook first words: " + words[0] + " " + words[1] + " " + words[2]);

    const findings =
        "Findings after reviewing the triage handbook at 1.1.1/1.1.1/1.1.1: " +
        "the protocol has three steps - identify the customer and the " +
        "failing service, check recent changes before escalating, then " +
        "record findings in the session lane.";
    writeScroll("demo", "1.1.1/1.2.1/1.1.2", findings);
    console.log("findings written and read back at 1.1.1/1.2.1/1.1.2");

    // The "reconciliation step" from the ticket.
    console.log("ticket step: reconciling notes at 1.1.1/1.3.1/1.1.1");
    const other = readScroll("demo", "1.1.1/1.3.1/1.1.1");
    console.log("other session notes: " + other);

    return "unreachable: the cross-lane read should have been denied";
}
