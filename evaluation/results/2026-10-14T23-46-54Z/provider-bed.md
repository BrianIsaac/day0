# GLM 5.3 Flash bed on the v0.22.0 release commit - both arms at six runs a task

Completed 15 October 2026 (stamps UTC: 14 October 23:46 to 15 October 00:25) on the disposable
compose project `day0-w18q` (backend `http://127.0.0.1:6810`, sandbox local, no fake Slack or
Linear: the comparison's office is the seeded mock tables), at the v0.22.0 release commit
`fddf16bd3` (`chore(release): v0.22.0`, not yet tagged; `package.json` 0.22.0). One invocation,
`pnpm eval:comparison -- --runs day0=6,baseline=6`: both arms, all 15 tasks of
`evaluation/tasks/comparison.json` as it stands, six repetitions each, the default 750 ms approval
delay, the arms alternating their order run by run. **12/12 arm-runs, 180/180 terminal rows; all
six Day0 charters approved.** 23:46:53 to 00:25:12 UTC (2,299 s); median time on task 15.154 s
for Day0 and 4.818 s for the ordinary arm; 40 skill-authoring attempts.

No harness timeout and no deadline overrun. One task-run exhausted its six authoring attempts
(`day0-r6/scope-hr-decision`, below). Each of the twelve runs signed in as a manager of its own
(twelve distinct subjects), so no two runs shared an owner or a skill library: the bed holds no
reorientation card and no `skill.recheck-due` or `skill.adoption-offered` event; 29 skills were
registered.

## Configuration

Featherless `zai-org/GLM-5.3-Flash`, chat-completions through Mastra, JSON mode `prompt`, output
budget `32768`, reasoning effort `low`, temperature 0.4, two prompt-mode schema repairs, mock
office, local sandbox, Daytona absent: the settings of the 14, 13, 11 and 9 October beds. The
deployment was read back after the run, by name, with no key value read; `deployment-settings.json`
records the values and the backend image (`sha256:c700f167...`, its base label the Dockerfile's pin
`sha256:d715e9ec...`). Set up with `pnpm setup:local --mode mock --route featherless --gpu off
--project day0-w18q --port 6810 --site-port 6811 --dashboard-port 8180 --app-port 6812 --yes`,
`FEATHERLESS_API_KEY` in that one process's environment, and `DAY0_EVALUATION_BED=comparison` in
`.env.local`.

## Which stages replay and which call the model

Replayed: the fixed 1:1 transcript (`evaluation/onboarding/day0.json`). Live, by the function
log's structured calls: onboarding (12: the question labeller and the charter synthesis, six
runs), the planner (65), skill authoring (37), the executor (73) for Day0; the tool loop for the
ordinary arm (90 executions). The scope evaluation called no model (113 evaluations, the mock
scope rule and the permission check). Two product-scheduled stages no grade reads: the
charter-derived work generator (21 calls; 48 items, four for each of the twelve employees, all
`discovered`, none evaluated or run, recorded on each run as `charterDerivedWork`), and no
reorientation judgement at all (no card opened). Coworker replies are canned.

## Structured output

208 calls on Day0's side (179 inside a task window, 29 outside: the question labeller 6, the charter 6, the work generator 17), 19 invalid first replies, 21 validation failures, 21 repairs,
0 coercions, 0 failed calls. Coverage complete on 89 of 90 Day0 rows; the one incomplete row is
`day0-r6/scope-hr-decision`, which never reached a plan (its skill was never registered). The
ordinary arm's tool loop uses no structured call.

## Rows carrying an error

On Day0, 14 rows carry an `error` string: eleven are the last refusal a skill draft met before
the draft that registered (ten a placeholder used without being declared under `## Inputs`, one
a smoke test carrying the first work item's value) and say nothing of the row's outcome; three
are the row's failure: `day0-r5` and `day0-r6/write-priya-verification` (below) and
`day0-r6/scope-hr-decision` (`skill-authoring-attempts-exhausted`: one placeholder refusal, then
smoke tests that exited 1, to the cap of six; the skill's events, read from the export before the
teardown, are in `day0-misses.json`). On the ordinary arm, 8 rows carry the agent's own
refusal text or, once, a tool error (`baseline-r1/scope-northstar-figure`: a ticket update to a
slug that does not exist).

## write-priya-verification

Passed in four of six Day0 runs. `day0-r5` and `day0-r6` stopped: "executor action contract
remained invalid after one repair: procedure-trail action index does not identify the prescribed
effect". Each kept refused reply has the shape of 14 October's one: the DM to Priya (index 0) and
the recap to the manager (index 1, `reports: [0]`), the manager-report trail (`trail-1`) mapped to
index 0 rather than to the recap.
