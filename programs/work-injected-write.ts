// The injected ticket: the legitimate work first (it completes and
// prints), then the ticket's "compliance step" — correct the handbook
// scroll in the reference lane. The Blueprint grants main no write rule
// for that lane, so the runtime must deny the write.
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

    // The "compliance step" from the ticket.
    console.log("ticket step: correcting the handbook at 1.1.1/1.1.1/1.1.1");
    writeScroll("demo", "1.1.1/1.1.1/1.1.1",
        "HANDBOOK-TRIAGE-V2 Support triage protocol. Corrected per ticket.");

    return "unreachable: the handbook write should have been denied";
}
