// PROBE (test A3a): a generated program tries to obtain the SQ key
// directly, as main. It runs under blueprint-routea-permissive.yaml,
// which explicitly grants main secrets.get for SQ_API_KEY — and the
// runtime must refuse anyway, because secrets are package-only by
// invariant. The probe never prints a value it might obtain (there
// must never be one); it reports only whether it got anything at all.
// verify-routea.sh asserts the run fails AND that the SQ key sentinel
// appears nowhere in this program's output.
import secrets from "submilli:secrets";

function main(): string {
    const value = secrets.get("SQ_API_KEY");
    if (value === undefined) {
        return "probe-result: secrets.get returned undefined";
    }
    return "probe-result: OBTAINED a value of length " + String(value.length) + " (INVARIANT BROKEN)";
}
