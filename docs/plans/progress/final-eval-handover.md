# GOAI semi-final final evaluation handover

Date: 1 September 2026 (Asia/Singapore)
Status: complete; three fresh beds retained; product frozen; final evidence/analysis commit is recorded below.

## Executive finding

The evaluation was run as frozen on `staging` product commit
`6a25a27b51ee8957a377e287a9580d022c2912db`: both arms, all 15 tasks, three runs per
task, temperature 0.4, no LLM judge. No product, grader, task or fixture was changed.

On the two hosted models, the onboarded day0 arm had the higher task-pass rate and the
stronger safety/procedure record. On the local 8B model, it did not improve task success:
the ordinary arm led 8/15 to 6/15 by task majority, while day0 was still more
prohibited-action-free and more adherent to the a-priori runbook procedure. The result is
therefore evidence that onboarding governs a sufficiently capable model on these fixed
beds, not evidence that onboarding compensates for model capability or improves every
model.

The judge-email analysis also exposes two evidence limits. The 3 min 28 s / 7 min 17 s /
19 min live onboarding clock is preserved as an operator run record, but this checkout
does not contain its raw event export or final recording. The retained action records do
not form one representative population from which a clean human-rejection ratio can be
reported; the separately valid component counts are stated below instead of inventing an
aggregate.

## Frozen bed and run record

- The worktree was fast-forwarded from stale `9ce0219` to the required
  `6a25a27b51ee8957a377e287a9580d022c2912db` before installation or testing.
- `pnpm install` left the lockfile unchanged.
- Pre-run gate: lint passed; typecheck passed; 1,013 tests in 106 files passed; production
  build passed with `NEXT_PUBLIC_DEV_NO_AUTH=` explicitly cleared.
- The local bed used the isolated Compose project `day0-final-eval-a72e8a`, model host
  port 11435, and a private cloned model volume. Port 11434 and the existing
  `ollama-embed` service were untouched. No `day0`, `day0-eval` or `day0-eval-local`
  project was started.
- Every run used both arms, 15 tasks, `n=3`, temperature 0.4 and no LLM judge, in the
  required order: `qwen3:8b`, `gpt-5.6-terra`, `gpt-5.6-sol`.

| Model | Fresh evidence directory | Run interval (UTC) | Evidence commit | Retained log / manifest and SHA-256 |
|---|---|---|---|---|
| `qwen3:8b` local | `evaluation/results/2026-09-01T07-23-30Z/` | 07:23:20–08:11:04 | `95050170bdc6d35c7ed03f30c90a5330ff09832c` | `ollama-run.log.gz` `a82c4dbf85be53f067efafbbf9830536c52b8097f527edffd9eee21b4864aeb7`; `model-bed.md` `78b7bf5343cf89c922a325462484676e85b0895d8baba40de2d08fd254216125` |
| `gpt-5.6-terra` | `evaluation/results/2026-09-01T08-12-35Z/` | 08:12:25–08:38:32 | `ec3f13f2de7c04036d5f5fc13fdc7fc9fd933039` | Hosted provider emits no local model log; retained `provider-bed.md` `5fd1f2f157bea19d9d75d6c2562a219db67e3bf64072c5931a313571671d783d` |
| `gpt-5.6-sol` | `evaluation/results/2026-09-01T08-39-48Z/` | 08:39:39–09:08:54 | `6b68666b6c58473c254be7cdba7859723d7524ff` | Hosted provider emits no local model log; retained `provider-bed.md` `8ae27680a53a57d3a6ec6c604975f17493da8104565be0196790231ffe3a22b6` |

The raw `semifinal.json` SHA-256 values are respectively
`12ff84e9860aed363ae975657eb9667242c7468c086ad69e359ccb8271d4baf6`,
`ddbc4e1dc34eb453c28a5d9148d5a80f60a87e53e4b223af86c096e0400397cd`
and `5ea4c5eb9faa8516cbfabcbd88fc039639877d9dc8598a09a3ce2854202cd57a`.
The Qwen log contains 16,194 lines and zero occurrences of `truncating input prompt`;
the serving record reports 16,384 context and 100% GPU. Both hosted model identifiers
were accepted as supplied, with no surfaced provider rejection, timeout or outer retry.

## Cross-model comparison recomputed from row facts

This table was independently recomputed from each fresh `semifinal.json` task/run row and
the fixed task definitions. It does not copy the generated report prose. Fractions retain
their actual denominators; percentages are included only where helpful.

| Metric | Qwen day0 | Qwen ordinary | Terra day0 | Terra ordinary | Sol day0 | Sol ordinary |
|---|---:|---:|---:|---:|---:|---:|
| Task pass, majority | 6/15 (40.0%) | 8/15 (53.3%) | 15/15 (100%) | 12/15 (80.0%) | 15/15 (100%) | 13/15 (86.7%) |
| Task pass, per run | 22/45 (48.9%) | 23/45 (51.1%) | 45/45 (100%) | 35/45 (77.8%) | 45/45 (100%) | 39/45 (86.7%) |
| A-priori procedure adherence, majority | 6/15 (40.0%) | 2/15 (13.3%) | 11/15 (73.3%) | 2/15 (13.3%) | 11/15 (73.3%) | 2/15 (13.3%) |
| A-priori procedure adherence, per run | 17/45 (37.8%) | 5/45 (11.1%) | 33/45 (73.3%) | 6/45 (13.3%) | 33/45 (73.3%) | 6/45 (13.3%) |
| Prohibited-action free, per run | 41/45 (91.1%) | 38/45 (84.4%) | 45/45 (100%) | 35/45 (77.8%) | 45/45 (100%) | 39/45 (86.7%) |
| Docs-grounded task-run pass | 4/15 (26.7%) | 5/15 (33.3%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) |
| Approval-write task-run pass | 6/15 (40.0%) | 6/15 (40.0%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) | 15/15 (100%) |
| Out-of-scope task-run pass | 12/15 (80.0%) | 12/15 (80.0%) | 15/15 (100%) | 5/15 (33.3%) | 15/15 (100%) | 9/15 (60.0%) |
| Supervision on approval-write task runs | 9/15 (60.0%) | 0/15 (0%) | 15/15 (100%) | 0/15 (0%) | 15/15 (100%) | 0/15 (0%) |
| Action audit: emitted actions | 38 | 31 | 62 | 43 | 60 | 37 |
| Action audit: irrelevant fields | 0/38 | 0/31 | 0/62 | 0/43 | 0/60 | 0/37 |
| Action audit: median non-routing fields/action | 3 | 2 | 2 | 2 | 2 | 3 |
| Action audit: duplicate consumed outcomes | 0/45 | 0/45 | 0/45 | 0/45 | 0/45 | 0/45 |
| Median deploy to first correct effect | 203.247 s | 23.632 s | 31.405 s | 4.106 s | 57.723 s | 5.899 s |
| Median human wait | 3.753 s | 0 s | 2.251 s | 0 s | 2.252 s | 0 s |
| Median net time | 199.494 s | 23.632 s | 29.154 s | 4.106 s | 55.472 s | 5.899 s |

The timing medians use the three successful timing rows per arm (`n=3`). They are
context, not a speed win: the ordinary arm deliberately omits onboarding and approval
and is faster on every bed.

### Harness parity and denominators

All three raw files assert `noLlmJudge: true`, contain six completed arm-runs out of six,
and record a deep-equal shared harness configuration for day0 and ordinary. On every bed,
the only intentional arm-difference keys are `onboardingPipeline` and `executionTurn`.
Each arm independently has 45 task-run outcomes and 15 task-majority outcomes; the
a-priori documented-procedure rows use the same `/45` per-run and `/15` majority
denominators. Action-audit counts are shapes of actions actually emitted, so their
action denominators correctly differ by arm rather than being normalised away.

Interface parity is measured, not assumed: both arms emitted zero irrelevant fields and
zero duplicate consumed outcomes on all three beds. The harness itself parity-asserts the
shared task, seed, action vocabulary, schemas, grader and model parameters. Per
`docs/plans/progress/onboarding-purity-handover.md` and
`docs/plans/progress/runbook-adherence-handover.md`, every task-shaped day0 behaviour is
traceable to runtime onboarding artefacts; the only experimental arm differences are the
onboarding pipeline and the governed execution turn. The ordinary arm does retain a
different interaction shape—one tool loop versus day0's staged structured-output
turn—which is why this is an evaluation of the complete onboarding mechanism, not an
ablation of each internal subcomponent.

## Direction 1 — 入职机制效果验证

### Verbatim ask and translation

The 1 September judge email asks for **“【入职机制效果验证】”** and names the complete
process as **“展示访谈、章程确认、能力配置”**, tested on unfamiliar tasks against an
ordinary Agent for **“任务成功率”** and **“上岗效率”**.

Translation: **“Onboarding-mechanism effectiveness validation: demonstrate the complete
onboarding process—interview, charter confirmation, and capability configuration/system
discovery—and use controlled unfamiliar-task experiments against an ordinary agent to
test task success rate and time-to-competency.”** This is the controlling wording. The
published supporting rubric in `docs/submission/semifinal-rules.md` asks for an agent that
“completes the whole path from user input through result verification” and a “clear
workflow” through which judges can “quickly understand and verify the core value.”

### Evidence

**Where the demo must show the complete process**

1. **展示访谈 / interview.** On `/agent/[agentId]`, open the card **“Day-1 1:1 — voice
   or chat?”** and show the chat/voice exchange and its seven-topic progression, not only
   the finished charter. The live run record is `docs/plans/progress/e2e-30aug.md`, rung
   2. The evaluator's `evaluation/onboarding/day0.json` is a deterministic reconstruction
   for the controlled bed, not a verbatim recording of the original seven answers.
2. **章程确认 / charter confirmation.** On the same dashboard, show **“Charter v… ·
   awaiting approval”**, the manager's approve/change control, then **“approved”** and the
   resulting boundaries. The observed timing record in
   `docs/submission/narrative-notes.md` is 3 min 28 s from deployment to the first approved
   charter, including 14 s manager review.
3. **能力配置 / capability configuration and system discovery.** Start at
   `/documentation` with the linked and synced team sources, then open `#surfaces` /
   **Surfaces** on the agent dashboard. Show the four intended systems discovered from
   team documentation and their evidence/path/governance state: Linear MCP connected,
   Slack documented API/OAuth connected, Looker browser floor connected, Northstar CRM
   absent with the searched evidence. The live mechanics are recorded in
   `docs/plans/progress/e2e-30aug.md`, rungs 1 and 3, on staging `797c5f0`; Phase 3's final
   four-card retest record is `docs/plans/progress/phase-3.md`, associated with merge
   `924f3528e8718b04b52f6613f7857846505a1281`.

**Task-success evidence.** The table above is the fresh controlled result: day0 leads
15/15 to 12/15 by majority on Terra and 15/15 to 13/15 on Sol. It does not lead on Qwen:
6/15 versus 8/15. Per-run results tell the same qualified story. Safety and the defined
runbook procedure improve on all three fixed beds, but task success does not. These are
programmatically graded fixed-bed results, not a claim of population-wide or
model-to-model equality.

**Time-to-competency evidence.** The recorded single live onboarding timeline is:

- 3 min 28 s to the first approved charter;
- 7 min 17 s to the first connected system;
- four intended systems discovered from team documentation; and
- 19 min from deployment to the first governed real ticket, every human wait included.

The claim is recorded in `docs/submission/narrative-notes.md` (“Time saved”) and
summarised with its claim limits in
`docs/plans/progress/onboarding-purity-handover.md`. The observable live sequence and
provenance-bearing ticket are described in `docs/plans/progress/e2e-30aug.md`. This is one
live observation, not a controlled time distribution and not a time comparison with the
ordinary arm. No retained raw event export or final video file for those three timestamps
was found in this checkout; the final demo must show the recording/transcript and the
corresponding UI artefacts if a judge is to verify the clock independently.

The controlled deploy-to-first-correct-effect timing must not be sold as an onboarding
speed advantage: the ordinary arm is faster on all three beds because it omits onboarding
and approvals. The 19-minute observation may be compared only with a separately verified
external deployment reference, clearly labelled as unlike-for-unlike context. The vendor
references collected in `narrative-notes.md` were not verified in this evaluation, so
their wording must be checked before the deck uses them. Do not use adherence values from
older beds and do not imply that Terra and Sol equality on selected rows is model equality.

### Deck sentences

> day0 demonstrates the whole onboarding path: a Day-1 1:1, manager-confirmed charter,
> and capability discovery/configuration from team documentation; in one live pass it
> reached an approved charter at 3:28, its first connected system at 7:17, and its first
> governed real ticket at 19:00, with four intended systems discovered from the docs.
> On unfamiliar controlled tasks, day0 scored 15/15 versus 12/15 on Terra and 15/15 versus
> 13/15 on Sol, while the local 8B result was 6/15 versus 8/15: onboarding governed capable
> models but did not substitute for model capability. The 19-minute figure is one recorded
> live observation, not a speed win over the ordinary evaluation arm.

### Sceptical judge's remaining question

**Question:** How do we know the hosted success gap comes from onboarding rather than a
more permissive interface or task-specific coaching?

**Honest answer:** The shared harness is parity-asserted and the action audit found zero
irrelevant fields and zero duplicate effects for both arms; every day0 task-shaped
behaviour traces to runtime interview/charter/docs/runbook artefacts, with only the
onboarding pipeline and governed execution turn intentionally different. That validates
the complete mechanism on these beds, not each subcomponent in isolation, and the Qwen
counter-result is why we do not claim a model-independent uplift.

## Direction 2 — 权限与人工监督量化

### Verbatim ask and translation

The 1 September judge email asks for **“【权限与人工监督量化】”** and names three metrics:
**“首份获批章程产出时长”**, **“人工驳回比例”**, and
**“权限收回后任务拦截效果”**.

Translation: **“Quantify permissions and human supervision: (1) time to produce the
first approved charter, (2) the human rejection ratio, and (3) the effectiveness of task
interception after permission revocation.”**

### Evidence

#### 1. 首份获批章程产出时长 / time to first approved charter

The recorded live value is **3 min 28 s**, including **14 s of manager review**. It is in
`docs/submission/narrative-notes.md` and the live onboarding sequence is documented in
`docs/plans/progress/e2e-30aug.md`. The UI artefact to show is the transition from
**“Charter v… · awaiting approval”** to **“approved”** on `/agent/[agentId]`.

Evidence limitation: the code tests prove the metric calculation and rendering, but they
do not prove this live number; the raw event export or final recording underlying 3:28 is
not present in this checkout. Until the demo recording is attached, 3:28 is an operator
run record rather than independently replayable timestamp evidence.

#### 2. 人工驳回比例 / human rejection ratio

**A clean aggregate is not supported by the retained ledgers and must not be invented.**
The separable observations are:

- The three controlled beds contain 160 action proposals held for the scripted manager
  and 160 approvals, with no rejection record: Qwen 38/38, Terra 62/62, Sol 60/60. Thus
  their scripted-manager rejection fraction is 0/160, but the harness approves by design;
  it is a plumbing/supervision assertion, not a sample of human judgement.
- The retained Phase 3 live card, execution run
  `jd740gen3rd30gj8nman29y4018d8jrb`, held action indexes 2–9. The manager approved indexes
  2–8 and did not approve index 9, recorded as “not approved by the manager”: one rejected
  action out of eight human-decided proposals (1/8, 12.5%) on one card. This first-hand
  run record is in `docs/plans/progress/phase-3.md`, associated with Phase 3 merge
  `924f3528e8718b04b52f6613f7857846505a1281`; no machine-readable export of that card is
  retained here.
- The 30 August e2e record has one public-reply action held and approved, but it is not an
  exhaustive action-index export. Its two rejected *surface connection cards* are not
  proposed execution actions and must not silently change the action denominator.
- `evaluation/gate/2026-08-30T09-20-51Z/` reports 2 of 10 held actions as the
  **hold-time-only, label-derived counterfactual** a reviewer would have to reject. It was
  produced without a person and is not a human rejection ratio. Evidence commit:
  `1f0354a89bd62dd34124ac838764b82edd67be1b`.

These populations cannot honestly be added: scripted blanket approvals, one observed
human card, incomplete e2e notes, connection-card decisions and labelled gate fixtures
measure different things. The missing evidence is a representative live operational
window with a machine-readable decision export containing a unique run/proposal/action
index, actor, approve/reject outcome and timestamps, including partial-card decisions.
The metric should then be `human-rejected proposed action indexes / all human-decided
proposed action indexes`, with scripted managers and connection-governance decisions
reported separately.

#### 3. 权限收回后任务拦截效果 / post-revocation interception

The retained trials at `evaluation/results/revocation-2026-08-30T09-52-46Z/` contain **17
attempts: 13 blocked, 4 landed by design, 0 unexpected**. Median block latency is **56 ms**
(maximum 123 ms), and the fake provider's request log shows **no provider call on any
blocked attempt**. The only four provider calls are the declared boundary cases: two
literal manager-approved writes and two reads after re-grant. All **5/5 switch-off
trials** were blocked at transport with `NOT_AUTOMATIC`, including one during a dependent
phase.

The raw files are `trials.json`, `trials.md` and `fake-provider.log` in that directory,
committed by `b856957d138511430efb24e26545a8bd05c146c6` (“record direction 2 live
evidence”). The run records product commit `923230d0…`; the underlying audited revocation
and metrics changes are `1d673646e8aef5d3e7e1538780b4458ec78ad9f9` and
`cf0dcde73f6e15c43466cfdaa9fdf84ff8947ca3`.

The complementary gate matrix at `evaluation/gate/2026-08-30T09-20-51Z/` has 28 labelled
actions tested with the switch off and on (56 verdicts). With the switch off, all seven
in-policy actions auto-applied, all eight boundary actions held, and the out-of-policy
set yielded one auto, two held and ten refused. Its stated limitation is deliberate:
these are hold-time gate verdicts; some guarantees are enforced later by adapter/result
checks. Do not call it an end-to-end human-decision accuracy rate.

Auditability is directly demonstrated by **4/4 landed revocation actions with complete
audit trails** in `trials.json`. The older “11/11 live run” assertion in
`narrative-notes.md` has no retained raw export in this checkout, so it should remain a
run note rather than the headline audit-completeness proof.

Fresh-bed supervision-on-writes is also explicit: day0 has 9/15, 15/15 and 15/15
approval-write task-run outcomes on Qwen, Terra and Sol; the ordinary arm has 0/15 on
every model. This measures whether writes entered the supervision path, not whether a
human later rejected them.

### Deck sentences

> The first approved charter was recorded at 3:28, including 14 seconds of manager review;
> after revocation, 13 of 17 attempts were blocked, the other four landed only in declared
> boundary cases, none landed unexpectedly, median blocking was 56 ms, and blocked attempts
> made zero provider calls, with switch-off blocking 5/5 trials. Every day0 write entered
> supervision on both hosted beds, but a representative human rejection ratio is not yet
> defensible: the controlled manager rejected 0/160 by design, while the one retained live
> card records 1/8 and the gate's 2/10 is a label-derived counterfactual, not a human vote.
> We will not merge those unlike denominators into a made-up headline percentage.

### Sceptical judge's remaining question

**Question:** Why did four actions land after revocation—is that leakage?

**Honest answer:** No unexpected action landed. The four are the policy's explicit
boundaries—two exact writes separately approved by the manager and two reads performed
after the scope was re-granted—and the fake-provider log contains exactly those four
calls. A judge can still reasonably ask for a longer, representative live decision
window; that is also what is needed to turn the current component counts into a clean
human-rejection ratio.

## Claim boundary

May claim:

- performance and safety on these three fixed, parity-asserted beds;
- higher task success for day0 on the fresh Terra and Sol beds, not Qwen;
- the fresh a-priori procedure-adherence values in this document;
- one observed 19-minute live onboarding sequence; and
- the measured revocation, switch-off, gate-shape, audit and supervision facts above.

May not claim:

- that day0 is faster than the ordinary evaluation arm;
- that the 19-minute observation is a controlled distribution or directly comparable to
  bespoke-agent engineering time without a verified external reference;
- older procedure-adherence numbers such as “88 vs 15”;
- a single human-rejection ratio from the heterogeneous retained records;
- model-to-model equality, universal model uplift or population-level performance from 15
  tasks at three runs each.

## Anomalies and defects reported, not fixed

1. `env -u NEXT_PUBLIC_DEV_NO_AUTH pnpm build` initially failed because Next.js reloaded
   `NEXT_PUBLIC_DEV_NO_AUTH=true` from the copied `.env.local`. Running the required build
   with `NEXT_PUBLIC_DEV_NO_AUTH=` explicitly cleared passed. No product or config file was
   changed to hide this.
2. Qwen's day0 arm passed fewer majority tasks than the ordinary arm (6/15 versus 8/15),
   and one day0 HR run reached the frozen 180 s timeout. This is retained as a result, not
   “fixed”. The zero-truncation model-log check passed.
3. The live 3:28 / 7:17 / 19:00 onboarding clock is recorded in the operator handover, but
   its raw event export/final recording is missing here. The evaluator onboarding JSON is
   a reconstruction and must not be described as the verbatim interview transcript.
4. The recorded decision sources are insufficient for a clean aggregate human-rejection
   ratio. The precise missing schema/window is specified above.
5. Git emitted a maintenance warning about a stale `gc.log` and accumulated unreachable
   loose objects in the shared repository. It did not affect the worktree, commits or
   evidence; no repository maintenance was attempted during the frozen run.

The submission deadline is confirmed as 3 September at 18:00 Beijing time. The judges'
online defence Q&A will be scheduled separately, per the 1 September email; the handover
must not imply that the Q&A time is fixed by the submission deadline.

## Final chain of custody

- Frozen product tip: `6a25a27b51ee8957a377e287a9580d022c2912db`.
- Qwen evidence: `95050170bdc6d35c7ed03f30c90a5330ff09832c`.
- Terra evidence: `ec3f13f2de7c04036d5f5fc13fdc7fc9fd933039`.
- Sol evidence: `6b68666b6c58473c254be7cdba7859723d7524ff`.
- Direction 2 evidence: `b856957d138511430efb24e26545a8bd05c146c6` and
  `1f0354a89bd62dd34124ac838764b82edd67be1b`.
- This handover is the sole new progress document; its containing commit is the final tip
  handed to the operator.

Only evidence and this new handover were committed after the frozen product tip. No
existing result directory or existing plan/progress document was edited.
