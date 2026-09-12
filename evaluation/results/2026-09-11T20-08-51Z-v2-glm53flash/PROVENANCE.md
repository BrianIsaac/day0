# Provenance of the commit identifiers in this record

This directory and the two pilot directories beside it were recorded on 12 September 2026.
Later the same day, the repository's history from `e1cb539` (4 September) forward was
rewritten to remove twelve private planning documents that had been force-added past the
gitignore, and to strip attribution trailers from commit messages. Two commit identifiers
recorded by the harness therefore no longer exist on the published branch. Their rewritten
equivalents carry byte-identical trees, so the code each run executed is unchanged.

| Recorded in | Original identifier | Rewritten equivalent | Tree, identical on both |
|---|---|---|---|
| this directory: `semifinal.json` `commit`, `semifinal.md`, `provider-bed.md` | `0dbcbb32393a0de548d14ba1a240f8e3dac7f7b9` | `d1216fb9b0bfde829fd03a36054c01b3181dcaac` | `6526613bc3c3ecef592e7a49012ba6d3d6890606` |
| `../2026-09-11T19-24-41Z/` and `../2026-09-11T19-56-20Z/`, the pilots | `45a0af1834b282d94b81c8027cbba8ea767e73be` | `3a810f2c77f9a2ccb91dc95e5b254b751529c383` | `af38b06f44f2ce6ac7515b5c09f3310afe24adfb` |

The frozen `semifinal.json` files keep their original `commit` field: it records the run as it
happened, and editing it would change the file's own hash. To check out the code that produced
any row, use the rewritten equivalent; `git rev-parse <id>^{tree}` on either side returns the
tree shown. Every commit cited by the semi-final submission is dated 4 September or earlier and
was not touched by the rewrite.
