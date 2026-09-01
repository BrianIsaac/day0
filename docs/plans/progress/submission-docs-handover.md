# GOAI semi-final submission documentation handover

Date: 1 September 2026 (Asia/Singapore)
Status: documentation complete; final gate and primary-checkout copy-back recorded below.

## Documents changed

- `README.md`: added a top-linked `## 中文说明` with a sober Simplified Chinese
  project explanation, contents, account-free route, OpenAI-key route and evaluation
  quickstart. Commands, paths, environment variables and identifiers remain unchanged;
  the local-model instructions retain the mandatory `OLLAMA_CONTEXT_LENGTH=16384`.
- `evaluation/README.md`: replaced the stale 30 August “latest” bed with the frozen
  Qwen/Terra/Sol evidence table; added evidence paths, all three `semifinal.json`
  SHA-256 values, the local model-log hash, fixed a-priori denominators, harness-parity
  wording, a Chinese headline summary and an explicit superseded-history boundary.
- `docs/submission/narrative-notes.md`: rebuilt the deck notes around the three fresh
  beds, the final Terra 33/45 versus 6/45 a-priori adherence result, the local 8B
  counter-result and Direction 2's retained evidence. The 19-minute live observation
  is labelled as one pass, not a controlled distribution or baseline-speed result.
  The Salesforce Engineering citation is verified and used only as the vendor's own
  FDE-assisted best case, with the 380× ratio labelled unlike-for-unlike in English
  and Chinese.
- `docs/submission/compliance.md`: replaced the Phase 0 outline with a complete
  bilingual statement covering the seeded-office provenance, three no-LLM-judge
  mock-mode beds, local real-mode verification, source authority, encryption and
  redaction, effect gates, retention/deletion, privacy limits and professional-risk
  boundary.

## Claims deleted or rewritten

| Previous claim | Disposition and reason |
|---|---|
| Old gpt-5.5/Terra/Sol/Qwen per-run table from 30 August | Deleted; those directories are superseded by the three frozen 1 September beds. |
| “Documented-procedure adherence 87.9/88 vs 15” | Deleted; it used the superseded outcome-conditioned denominator. Final Terra a-priori evidence is 33/45 versus 6/45 in `2026-09-01T08-12-35Z`. |
| Old combined out-of-scope totals and examples | Deleted; replaced by per-bed final rows so unlike model beds are not pooled into a narrative total. |
| “Every day0 write held; none of the ordinary agent's” | Rewritten as supervision-on-approval-write task runs: 9/15, 15/15 and 15/15 for day0 versus 0/15 on every ordinary arm. |
| “21–31 s versus about 4 s” and “time-to-trusted: 27 seconds” | Deleted; the ordinary arm omits onboarding and approval by construction, so controlled timing cannot support a day0 speed win. |
| “The gap survives the model” | Rewritten; day0 leads on Terra and Sol but loses 6/15 to 8/15 on local Qwen, so onboarding does not substitute for model capability. |
| “Two of four systems came from documentation” | Rewritten to the supported live observation that four intended systems were discovered from team documentation. |
| “Human override rate 2/10” | Deleted as a human metric; 2/10 is a label-derived gate counterfactual with no person. The scripted 0/160, retained live-card 1/8 and fixture 2/10 populations remain separate. |
| “Audit trail 100% (11/11) on the live run” | Removed from the headline because no raw export is retained; replaced by the machine-readable 4/4 complete landed-action audit rows in the revocation trials. |
| Kiteworks “40% of organisations” reference | Deleted; no verified primary citation was present and it was unnecessary to the measured revocation result. |
| Oliv 22-week / 2,500×, Gartner, agency MCP estimates and Oxford/AllenComm analogues | Deleted; no verified primary citations were present and the comparisons were not needed. |
| Salesforce 3-week / 380× comparison | Retained, not pending: the primary Salesforce Engineering source is verified. It is explicitly the vendor's own FDE-assisted best case across 150+ enterprises and is visibly unlike-for-unlike against one 19-minute day0 pass. |

## Pending markers left

- **PENDING — tonight's walkthrough metrics:** no new time or rejection rate until a
  recording/event export and representative machine-readable decision window exist.
- **PENDING — `qwen3:14b` bed:** no score, evidence directory, report hash or model
  log is claimed until that bed exists.

## Native-speaker review

Double-check the preferred competition vocabulary for `arm`, `surface`,
`exact-action gate`, `standing grant`, “governed real ticket” and
“unlike-for-unlike”. Technical identifiers are deliberately retained where they map
to UI, code or evidence; a reviewer should confirm that this code-switching is
helpful rather than distracting. Also verify that the Chinese Salesforce caveat
cannot be read as an enterprise-deployment equivalence or controlled speed result.

## Verification and custody

- Pre-edit baseline: `pnpm lint` passed; `pnpm typecheck` passed.
- Final gate: `pnpm lint` passed; `pnpm typecheck` passed; `pnpm test` passed with
  106 files / 1,013 tests; production `pnpm build` passed with
  `NEXT_PUBLIC_DEV_NO_AUTH=` and the documented loopback
  `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210`. The first build attempt exposed
  only that this isolated worktree had no `.env.local`; supplying the documented
  build-time URL required no file change.
- Tracked documentation commits: `421015f` and `ec398e4`; this handover is committed
  separately.
- The two gitignored submission files and this handover are copied back only to the
  corresponding paths under `/home/brian-isaac/Documents/personal/day0/docs/` after
  the final commit. No other primary-checkout file is modified.
