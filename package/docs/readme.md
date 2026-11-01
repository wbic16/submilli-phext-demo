# @wbic16/phext

Phext scroll storage for agent programs. A phext is plain text extended
with nine delimiter bytes, giving every scroll (piece of text) an
11-dimensional coordinate inside a single file. This package stores one
phext per identifier as one file on the filesystem and exposes exactly
four operations over it.

## Concepts you must use correctly

- **A scroll is identified by phextId + coordinate, never by coordinate
  alone.** Coordinates are internal to a phext: the same coordinate in a
  different phext is a different scroll. The `phextId` you pass is bound
  by the application when it opens the session; you cannot change which
  phext a session is bound to, and calls naming another phext are denied.
- **A coordinate** is written `Library.Shelf.Series/Collection.Volume.Book/Chapter.Section.Scroll`,
  e.g. `1.1.1/1.2.1/1.1.2`. All components are 1-indexed.
- **A lane** is a coordinate's first two groups, e.g. the lane of
  `1.1.1/1.2.1/1.1.2` is `1.1.1/1.2.1`. The package computes the lane from
  the coordinate itself and reports it to the permission check; you do
  not supply it. Blueprints typically grant reading across a reference
  lane and reading/writing in one session lane, and nothing else. A call
  outside the granted lanes is denied by the runtime, outside your
  control — when a call is denied, report it and stop; do not try other
  coordinates, other phexts, or other operations to reach the same data.
- **Writes are whole-scroll**: `writeScroll` inserts or replaces the
  complete text at one coordinate. There is no append or partial edit.
- **Scroll contents are never part of a permission payload.** Checks
  report only the phextId, the coordinate, the computed lane, and (for
  writes) the byte length.

## Operations

### `toc(phextId): string[]`

Lists the coordinates of every scroll in the phext, in file order. Use
it to discover what exists before reading. It reports only the phextId
to the permission check, so a Blueprint may allow listing a phext whose
individual scrolls you may not all read.

### `readScroll(phextId, coordinate): string`

Returns the text of one scroll. Throws if no scroll exists at that
coordinate in that phext. Reports `{ phextId, coordinate, lane }`.

### `writeScroll(phextId, coordinate, text): void`

Inserts or replaces one whole scroll at the coordinate. Reports
`{ phextId, coordinate, lane, length }` where `length` is the byte
length of `text`. Writing a coordinate in a lane the Blueprint has not
granted for writing is denied before anything is stored.

### `checksum(phextId): string`

Returns the SHA-256 (hex) of the phext file's raw bytes — a fingerprint
of the whole phext, useful to confirm two readers saw the same state.
Reports only the phextId.
