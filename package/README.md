# @wbic16/phext

Phext scroll storage as a Submilli Package: one `.phext` file per
identifier on the session/volume filesystem, four coordinate-addressed
operations (`toc`, `readScroll`, `writeScroll`, `checksum`), each
guarded by a semantic permission check reporting
`{ phextId, coordinate, lane }` (plus `length` for writes) — never
scroll contents.

## For installers

- **Credentials:** none. The package calls no network service and reads
  no secrets. It needs only filesystem access (see below).
- **What the package itself requires** (grant under the package's own
  caller list in your Blueprint):
  - `fs.mkdir` with `path == "/phext" and recursive == true`
  - `fs.read`, `fs.write`, `fs.stat` — grant them narrowed with
    `path glob "/phext/*"`; the build derives them unfiltered because
    paths are computed at runtime, and the linter will warn that your
    grants are narrower. That narrowness is the intended confinement.
- **What to grant `main`:** the four operations in
  `capabilities.yaml`, filtered on `phextId == ${vars.phextId}` and, for
  scroll operations, on `coordinate glob "<lane>/*"` for each lane the
  session may read or write. See `../../blueprint.yaml` in the demo for
  a complete worked example.
- **Files:** each phext lives at `/phext/<phextId>.phext` in the
  program's filesystem. There is no upload API: seed a file by placing
  it in the session directory (demo) or on a named volume (production).
