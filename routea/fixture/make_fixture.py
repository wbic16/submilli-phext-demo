#!/usr/bin/env python3
"""Build fixture/demo.phext and verify it by parsing it back.

The byte model is the dead-reckoning walk in ~/workspace/phext/parse_phext.py:
scrolls appear in coordinate order; a delimiter byte steps the coordinate.
From 1.1.1/1.1.1/1.1.1:
  0x17 (scroll)  -> 1.1.1/1.1.1/1.1.2
  0x1C (volume)  -> 1.1.1/1.2.1/1.1.1
  0x1C (volume)  -> 1.1.1/1.3.1/1.1.1
"""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "workspace" / "phext"))
from parse_phext import parse  # noqa: E402

SCROLLS = [
    ("1.1.1/1.1.1/1.1.1", None,
     "HANDBOOK-TRIAGE-V1 Support triage protocol. "
     "Step one: identify the customer and the failing service. "
     "Step two: check recent changes before escalating. "
     "Step three: record your findings in your own session lane."),
    ("1.1.1/1.1.1/1.1.2", 0x17,
     "Escalation notes. Escalate to a human operator when the customer "
     "asks for a refund above the handbook limit, or when a second "
     "service fails during the same incident."),
    ("1.1.1/1.2.1/1.1.1", 0x1C,
     "Session opened. No findings yet."),
    ("1.1.1/1.3.1/1.1.1", 0x1C,
     "OTHER-SESSION-NOTES Private working notes from another support "
     "session. Not part of this session's briefing."),
]


def main() -> int:
    out = Path(__file__).with_name("demo.phext")
    data = bytearray()
    for _coord, delim, text in SCROLLS:
        if delim is not None:
            data.append(delim)
        data += text.encode("utf-8")
    out.write_bytes(bytes(data))

    parsed = parse(str(out))
    got = [(c, t) for c, t in parsed]
    expected = [(coord, text) for coord, _d, text in SCROLLS]
    if got != expected:
        print("MISMATCH parsing fixture back:")
        print("  expected:", expected)
        print("  got:     ", got)
        return 1
    digest = hashlib.sha256(bytes(data)).hexdigest()
    print(f"demo.phext: {len(data)} bytes, {len(got)} scrolls, parse-back OK")
    for coord, _text in expected:
        print(f"  {coord}")
    print(f"sha256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
