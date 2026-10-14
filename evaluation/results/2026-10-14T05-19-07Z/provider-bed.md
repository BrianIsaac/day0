# GLM 5.3 Flash bed on the v0.21.0 release commit - both arms at six runs a task

Completed 14 October 2026 on the disposable compose project `day0-w17q` (backend
`http://127.0.0.1:5690`, sandbox local, no fake Slack or Linear: the comparison's office is the
seeded mock tables), at commit `c6cc7e6a2`: the `staging` tip `62658ad83`, which carries the
release commit `eab825fff` (`v0.21.0`, not yet tagged), with seven evaluation commits on it (the
harness of 14 October); no file under `convex/` differs from the release commit. One invocation,
`pnpm eval:comparison -- --runs day0=6,baseline=6`: both arms, all 15 tasks of
`evaluation/tasks/comparison.json` as it stands, six repetitions each, the default 750 ms approval
delay, the arms alternating their order run by run. **12/12 arm-runs, 180/180 terminal rows; all
six Day0 charters approved.** 05:19:06 to 06:19:38 UTC (3,632 s); median time on task 16.780 s
for Day0 and 6.497 s for the ordinary arm; 37 skill-authoring attempts.

No harness timeout, no deadline overrun and no exhausted authoring cap. Each of the twelve runs
signed in as a manager of its own (twelve distinct subjects, `managerSubject` on each run), so no
two runs shared an owner or a skill library: the bed holds no reorientation card and no
`skill.recheck-due` or `skill.adoption-offered` event, where the 13 October bed held two cards and
twelve such events, and 30 skills were registered, each run authoring its own.

## Configuration

Featherless `zai-org/GLM-5.3-Flash`, chat-completions through Mastra, JSON mode `prompt`, output
budget `32768`, reasoning effort `low`, temperature 0.4, two prompt-mode schema repairs, mock
office, local sandbox, Daytona absent: the settings of the 13, 11 and 9 October beds. The
deployment was read back before the first model call, by name, with the key's presence counted
and never printed; `deployment-settings.json` records the values and the backend image
(`sha256:b474a7b5...`, its base label the Dockerfile's pin `sha256:d715e9ec...`). Set up with
`pnpm setup:local --mode mock --route featherless --gpu off --project day0-w17q --port 5690
--site-port 5691 --dashboard-port 7930 --app-port 5692 --yes`, `FEATHERLESS_API_KEY` in that one
process's environment, and `DAY0_EVALUATION_BED=comparison` in `.env.local`.

## Which stages replay and which call the model

Replayed: the fixed 1:1 transcript (`evaluation/onboarding/day0.json`). Live, by the function
log's structured calls: onboarding (12: the question labeller and the charter synthesis, six
runs), the planner (66), skill authoring (37), the executor (75) for Day0; the tool loop for the
ordinary arm (90 executions). The scope evaluation called no model (114 evaluations, the mock
scope rule and the permission check). Two product-scheduled stages no grade reads: the
charter-derived work generator (23 calls; 48 items, four for each of the twelve employees, all
`discovered`, none evaluated or run, recorded on each run as `charterDerivedWork`), and no
reorientation judgement at all (no card opened). Coworker replies are canned.

## Structured output

213 calls on Day0's rows, 18 invalid first replies, 23 validation failures, 22 repairs,
0 coercions, 1 failed call (`day0-r3/write-team-handoff`, the skill's initial reply not satisfying
the schema after its repairs: the row failed). Coverage complete on all 90 Day0 rows; the
ordinary arm's tool loop uses no structured call.

## Rows carrying an error

On Day0, 14 rows carry an `error` string: twelve are the last refusal a skill draft met before the
draft that registered (a placeholder used without being declared under `## Inputs`, or one
smoke-test failure), and say nothing of the row's outcome; two are the row's failure
(`day0-r3/write-team-handoff`, above, and `day0-r3/write-priya-verification`, below). On the
ordinary arm, 8 rows carry the agent's own refusal text or, once, a tool error
(`baseline-r6/scope-northstar-figure`: a ticket update to a slug that does not exist).

## write-priya-verification

Passed in five of six Day0 runs. `day0-r3` stopped: "executor action contract remained invalid
after one repair: procedure-trail action index does not identify the prescribed effect". The row
now keeps the refused reply (`refusedReply` on the result): both the first reply and the repaired
one emit the DM to Priya (index 0) and the recap to the manager (index 1, `reports: [0]`) and map
the manager-report trail (`trail-1`) to index 0, the DM to Priya, rather than to the recap; the
contract refuses that mapping in mock mode with this sentence (`src/work/execute-skill.ts:2187`).
