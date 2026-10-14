# The second model: the conflict walk and the reorientation judgement on gpt-5.6-terra

Read 14 October 2026 on the disposable compose project `day0-w17q`, real mode, at commit
`c6cc7e6a2` (the v0.21.0 release commit `eab825fff` with the evaluation changes of that day; no
file under `convex/` differs). The second model is OpenAI `gpt-5.6-terra` at `api.openai.com`, the
key route (`./setup.sh --route key --model gpt-5.6-terra`), structured output native; the first is
Featherless `zai-org/GLM-5.3-Flash`, JSON mode `prompt`. Nothing was tuned to either model. The
fake Linear and the fake Slack stood in for the vendors; no real vendor was called.

## The conflict walk (the real planner's conflict rule)

The bed: the company pages (`--company`) and the conflict walk's pages of 12 October 2026
(two `close-comment-limits.md` pages, 120 words in the Revops folder and 60 in the Policies
folder, and the other window pages), linked as three folder sources (Revops, Policies, Systems);
Priya deployed with the charter drafted on 30 September 2026 (`WAVE6_MIRA_DRAFT` in
`tests/fixtures/charter-paraphrase-2026-09-30.ts`), imported and approved; orientation, on the
second model, proposed Slack (documented API) and Linear (MCP), as GLM did on a bed of 13 October; both approved and connected through the fakes. The comment-length pair confirmed as
disagreeing (`docRelations:decide`, `disagree`) before the tickets were filed. Two tickets filed
on the fake Linear, delegated to the app (`walk/tickets.txt`; the earlier walk's wording was not
kept, so these are new). Everything else is the product's own: intake, the scope evaluation, the
skill's proposal (approved, then authored by the call the dashboard makes), the drafts, the
question, the run, the Retry.

| Draft | gpt-5.6-terra, 14 Oct, v0.21.0 | GLM 5.3 Flash, 13 Oct, the v0.20.0 code (as recorded then; those drafts are not kept here) |
|---|---|---|
| REVOPS-2, first draft (`walk/terra-draft-revops2.txt`) | Both disputed passages cited, on the step that asks the manager in the DM and on the step that writes the comment; no side chosen; the question asked ("... holds its writes to Slack and Linear until you answer and Retry") | The tagged passage cited on a step of its own that asks the manager in the DM; the question asked; it held only the writes to Slack, so the Linear comment was not held by it |
| REVOPS-1, first draft (`walk/terra-draft-revops1.txt`) | No disputed passage cited and no dispute named: the neighbouring "What a comment carries" passage on the comment step, the plan built round a NetLedger access gap; nothing asked about the comment's length | The neighbouring "What a comment carries" passage cited, with the dispute named in the summary and the step said to be held; nothing asked |
| REVOPS-1, drafted again after the manager declined it with "Go ahead with the comment and the status change now; keep the comment short." (`walk/terra-draft-revops1-redraft.txt`) | The Revops "Comment length" passage cited on the step that writes the comment, which is to be kept "below 60 words, so it complies with both documented comment limits". This draft came after the pair had been answered "Both hold" (below), so the passage carried no conflict tag and no question was due | Both tagged passages cited, on the step that drafts the comment and writes nothing, the plan staying "within 60 words, the shorter of the two conflicting limits, so it satisfies either page" under a re-confirmed conflict; the question asked |

**What the run did on the second model** (`walk/terra-revops2-stop.txt`, `-retry.txt`,
`-after-both.txt`). REVOPS-2's plan approved with its question open: the run sent the DM asking
which limit governs and stopped with both Linear writes unsent ("2 approved plan steps remained
blocked"). The manager confirmed the provider (`workRuns:reconcileFailed`, the DM landed) and
retried with the note above: the plan ran again as it stood (Retry resumed at `plan-approved`),
the executor emitted a three-line comment of under 30 words and the move to Done, and the product
withheld both because the conflict's question was still open, beside the executor's own question
("Which limit governs for future audit comments?"). The pair answered "Both hold" on the card
dismissed it; a second `disagree` was then refused ("That card has changed: this answer is no
longer offered"), so 13 October's re-confirmation could not be repeated; a further Retry ran the
same plan, and the held comment and status change waited for the manager at `actions-pending`.

## The reorientation judgement on the same cards (`judgement-cards.json`)

| Card | GLM 5.3 Flash | gpt-5.6-terra |
|---|---|---|
| Access revoked, the revocation trial's employee (joined revocations of `slack:read`, `slack:write`, `boss:message`) | `none` | `none` |
| Access revoked, Priya's `linear:read` | `skill-action`, re-check the comment-and-close skill | `skill-action`, re-check the comment-and-close skill |
| Role changed by hand ("From next week Priya also covers the finance close desk, alongside revenue operations.") | `charter-change`, one will-do clause edited to add the finance close desk | `charter-change`, the same clause edited the same way |

Each card was opened once and judged by the model the deployment named then (GLM for the first,
gpt-5.6-terra for the other two); its proposal was read, set back to `pending` (a construction
step: the judgement answers only a pending card) and asked again with the deployment pointed at
the other model and its backend restarted. The kinds agree on all three; the rationales differ in
voice (the second model writes in the employee's first person on the role change, GLM in the
second). A page marked superseded opened no card, since none of Priya's work rested on it.
