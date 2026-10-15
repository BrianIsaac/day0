# Stored beds read again on the v0.22.0 release commit

Read on 15 October 2026 (the stamp is UTC: 14 October 23:33:56) from a clone at the
release commit `fddf16bd3` (`chore(release): v0.22.0`), with no model call and no backend:
`pnpm eval:comparison -- --reread <evidence.json> --out <bed>/<file>`, one invocation a
file, on the same nine sources 17-Q read on 14 October for the second reading. Each
subdirectory holds that invocation's evidence and report as written.

No grader file changed between `v0.21.0` and the release commit: `evaluation/` and
`scripts/eval-comparison.ts` are byte-identical, and of the product modules the grader
imports only `src/work/stop.ts` changed, not in `STOPPED_PREFIX`, the one value the
grader reads from it.

| Bed | File | Source | Against 14 October's re-read |
|---|---|---|---|
| Qwen3 8B, 2 Sep | `v2-qwen8b/comparison.json` | `2026-10-13T03-19-21Z-reread-v2-qwen8b` | equal but for the time and the grader's commit |
| GPT-5.6 Terra, 2 Sep | `v3-terra/comparison.json` | `2026-10-13T03-19-24Z-reread-v3-terra` | equal but for the time and the grader's commit |
| GPT-5.6 Sol, 2 Sep | `v3-sol/comparison.json` | `2026-10-13T03-19-27Z-reread-v3-sol` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 12 Sep (first) | `v4-glm53flash/comparison.json` | `2026-10-11T05-50-47Z-reread-v4-glm53flash` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 12 Sep (second) | `v5-glm53flash/comparison.json` | `2026-10-11T05-50-49Z-reread-v5-glm53flash` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 9 Oct | `9-october-glm53flash/comparison.json` | `2026-10-11T05-50-51Z-reread-9-october-glm53flash` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 11 Oct | `11-october-glm53flash/comparison.json` | `2026-10-11T05-50-13Z` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 13 Oct | `13-october-glm53flash/comparison.json` | `2026-10-13T03-18-41Z` | equal but for the time and the grader's commit |
| GLM 5.3 Flash, 13 Oct, ordinary runs 4 to 6 | `13-october-glm53flash/ordinary-runs-4-to-6.json` | `2026-10-13T03-18-41Z/ordinary-runs-4-to-6.json` | equal but for the time and the grader's commit |

Every count of 14 October's table stands, cell for cell.

## The 14 October bed (v0.21.0)

`pnpm eval:comparison -- --reread evaluation/results/2026-10-14T05-19-07Z/comparison.json`
is refused, exit 1: "day0-r1/scope-hr-decision already records the second reading". That
bed was graded live with the two readings and the second reading, so the path leaves
nothing to compute, and no file is written for it. Read instead from its retained grades by
the release commit's grader (`retainedOutOfScopeReading` and
`retainedDecidedCountingManagerMessage`, as `--reread` reads an older bed), its 60
out-of-scope rows agree with every reading graded live wherever the retained grade can
count the row:

| Arm | Rows | Decided | Explained | Second reading |
|---|---:|---:|---:|---:|
| Day0 | 30 | 30/30 | 6/30 | 30/30 |
| ordinary | 30 | 7/30 | 7/30 | 7 shown, 14 not countable |

The fourteen uncountable rows are the ordinary arm's runs whose only write was one message;
graded live, with the backend's record of where each went, eleven of them counted (18/30).
`tests/evaluation/reread-v0-22-0.test.ts` reproduces each file here from its source, holds
each equal to 14 October's but for the two provenance fields, and holds the 14 October
bed's agreement and counts above.
