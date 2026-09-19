# Changelog

Version maintenance record for Day0, from the git history, grouped by the milestones the project has shipped against. Day0 has no semantic-version releases; each milestone is a named commit, and `goai-final` is the only tag. Hashes are the commits on `main`, 1,607 of them at `f739614`; a merge of a job branch is listed by the substantive commits it carried, and counts are by author date. Every commit follows conventional-commit style, so `git log --no-merges --format='%ad %h %s' --date=short` is the full record and this file is its digest.

## goai-final: the finals build, 16 to 19 September 2026

The tag `goai-final` marks this release; it moves onto the merge that lands this entry. The recording ran on `f739614`, the last commit dated 19 September, and the hosted halves were brought to it on 20 September 2026: the cloud Convex functions first (293 functions, three new empty tables, no row of the protected office changed), then the app at `day0-olive.vercel.app`. 415 commits dated 17 to 19 September; 3,515 tests.

### 19 September 2026

- `766d0b7`, `610d228`, `976d348`, `706956d`, `195edb0`, `650f081` fix(surfaces): class a documented RPC read as a read whatever its verb or body, send its JSON body parameters in the query and leave a token argument behind; class a documented-API call by its operation and drop a refused read instead of stopping
- `ee6678b`, `95b249d`, `eb28ff7`, `40ec2bf`, `142f60f`, `9c878cf` feat(work): read the writes a plan leaves to the manager's answer and the question beside them; withhold those writes and stop with the question; keep a question open across a retry with no answer; the card says a stopped run is waiting on the manager's answer
- `5c4443d`, `5d8358d`, `1de3444`, `5ac6437`, `b253d09`, `106af52`, `a0acc5c`, `2eb4049`, `7948f49` fix(work): author the closing set once more when the asker is still owed a reply or a claim withheld its writes; read the held items again when the set comes back; keep the holders a set was authored under; record a completed reply only when it is sent; never complete a mention whose thread has no reply
- `94fa6d7`, `810b170`, `08e686a`, `3a28836`, `c7ab627`, `034d223`, `c2ae7ed`, `e9bdd79` feat(claims): name the external items a write addresses; withhold a write to an item another work item holds, claimed or not; store a ticket's other name at intake and match a write naming either; tell the executor which external items other work items hold
- `ba6986b`, `eeae5dc`, `52df49f`, `c9ce539`, `ac44e41`, `d42a5a0` fix(skills, work): bind the reply surface from the reply target; tell the real-mode author which surface carries the reply and hold a smoke case's reply to it; list the reply surface Day0 binds for an older skill
- `5bd44d7`, `2fbd3fc`, `919ec19`, `3776739`, `c65092f`, `97fb2e3`, `e967610`, `ba3d262`, `a91035c`, `c207d73`, `f1fa31d`, `a088ab3` fix(scope): ground a source on its bounds or its channel, never on the surface's name alone; take only a listed, unconnected system for an absent one; read authority clauses as met by supervision and hold a row's in-scope verdict; a skip of an item from a source the willDo names cites what excludes it; keep every re-admission key a row has spent; re-admit a parked row whose wait is over on Check for new work
- `86cc400`, `b92d347`, `7178eb6`, `7f94cbc`, `f4ef383`, `1a5919c`, `db374cc` fix(orientation, surfaces): ground a scope pick on its numbered candidate, offer the fullest page's candidates first, show the pick what the page says about each channel, name the pick number and the true reason in every drop note
- `871eec9`, `d08afe4`, `d9d25dd`, `4c53abb`, `ad2dae4`, `465e538`, `b117dff`, `b5672c8`, `acbe8e0`, `67257aa`, `43f6c8d` fix(skills): a harness, not the author, judges a real-mode smoke test, held to the skill the manager approved; declare an input the author used but did not declare; refuse a credential-named input; keep a failed attempt whole and secrets off the row; redact what the sandbox printed and print the source line under each frame
- `c0ac1e0`, `da9cedf`, `305d1aa`, `c5e3df3`, `b15b86a`, `b15b1de`, `3a9d7c1`, `ab8e43e` fix(skills, work): give the skill-registered-during-evaluation race one owner; re-queue every item waiting for a skill after it registers and release them when a proposal is rejected; skip an item the registered skill does not cover; a one-off re-queues rows an earlier registration stranded
- `bd10ac3`, `d8e8a92`, `4d44e3b`, `eed6db8`, `bddadd2`, `c7ef49f`, `1509356`, `b08cbf7` fix(work): count the item's plan-grounding read as a landed read and hand it to the executor; give both executor phases the work item as claim evidence; hold the carried-read round to the cap; a retry note releases the declared read it removed; take only what the item reports as evidence
- `e57974a`, `7b1ccae`, `94ee3c0`, `419744d` fix(work): pass the completion note's lines through the structural token floor; say a mid-sentence thread reference in words; tell the manager what landed in words and say what the count counts; keep the raw channel id and thread timestamp out of a message a person reads
- `5779b57`, `6cece07`, `ab0f1ec`, `af336ec`, `10828fe`, `fd9f7d4`, `d9ca09c`, `f61d80a`, `0f3dfa5`, `1e166c0`, `e871ce4` fix(dashboard): name the skipped row's control and list a stopped run above skipped rows; drop a sent retry note so a finished card owes no reconciliation; keep the bound-by-Day0 mark to registered skills; say when autonomous actions were turned on after a plan was drafted; show the employee's own blocked steps beside the gate's reason; render a skill's verification log with its line breaks and show its inputs
- `53addeb`, `e4be693`, `734b37e`, `c73b5e2`, `8ed6be8`, `e1c6c47` fix(work, surfaces, plan): end a run the gate cut short as stopped, with a reason the manager can act on; tell the real planner what a new ticket needs and that a refused step stops nothing else; retry a probe once before a dropped connection writes listed-dead and record the retry; make no keyed retry for a row whose approval was withdrawn; sign a ticket create in its description
- `222e32b`, `841c7a0`, `a2ebf51`, `fcc5355`, `f24c80f`, `9e5b27f` fix(day-one, rehearsal): put the scripted question after words that follow a dropped close; treat a budget-cut reply as cut and an unconfigured model as a 503; honour dayOneComplete only after topic 7 has its answer; never leave the 1:1 on an empty or cut model turn
- `e4a63ec`, `2b40027`, `11ef5b0` fix(intake, surfaces): store the app's bot id when a Slack surface connects and never read the app's own posts as asks
- `367c1b6`, `afdf41b`, `9ccda76`, `17699ec`, `15c0579`, `2ceb139`, `e1e8fea`, `c7eeebc` fix(landing, metrics, revocation): count stopped and parked work on the employee list and read each skill once; count a write the gate refused at apply time under refused; stop the rung at once when a trial row ends where no outcome is
- `7f21516`, `e39909f`, `a8ba7b2`, `533ae73`, `a37ac01`, `64e6de2`, `0d7681f`, `7e9995a`, `1af71f8`, `9869706`, `fc4212b`, `052fa4f`, `41d235e`, `739907a` feat(bed): the standing asks for the full run and the one-each sitting, checked and flagged; recognise a ticket a run filed as the run's own; retry each Linear call once, carry teardown past a failed call, journal ownership before provider writes
- `6029769` fix(documentation): empty the link form after a source is linked; `220df89` chore(next): turn the development indicator off
- `704db94`, `f5b6174`, `b1bb66e`, `614f792`, `ecb8505`, `7626115`, `3d73874`, `82f4216`, `4801bdc`, `9c5c0be` test: timeouts above their own bounds for the load-sensitive suites, token-shaped values assembled at run time, the provisioning proof on a free port

### 18 September 2026

- `a195a19`, `4b45a9c`, `04e963a`, `6cf98ba`, `92b4c82`, `c095855`, `325b206`, `a9af98e`, `849be5b`, `ec05fc3`, `f0c887c`, `400ae2b`, `0fe246b`, `4ef3c4b` feat(work): the server moves the work in real mode, each transition scheduling the employee's next step, with internal evaluate and draft steps claimed once per row, a five-minute cron that resumes stalled steps, and a Check for new work button on each queue; the page drives the loop in mock mode only
- `3d84ca3`, `086559d`, `143b9fd`, `c8e15cd`, `40040c4`, `1876731`, `f0fe271`, `93c1ff1`, `0cf3ff2`, `2ab20a4` feat(landing, metrics): the company above the office, one row per employee, with a company supervision card; `metrics:forOwner` and `pnpm metrics:recompute` reproduce the figures from an export
- `f141455`, `a48582c`, `9786bc8`, `2ab8c0a`, `ead055c`, `9eeec10`, `1a478aa`, `bc5cca4`, `e72535b`, `abe7ce9` feat(work): one live claim per provider item across the company in the `externalClaims` table, keyed by the provider, taken in the apply, released on cancel and retaken on retry; the card names the colleague who holds an item
- `3dc8381`, `32a3876`, `9453cb5`, `7093a19`, `0efe667`, `bb0c876`, `ebdf16e`, `f046897`, `aa013f0`, `d582600`, `c1efdac`, `f64fb34` feat(work, dashboard): keep the manager's corrections for the employee's later work and plan with them; show the kept corrections and where a plan applied one; give a plan's cancel a reason, and Retry on a cancelled plan drafts a new one for the manager
- `220bbbb`, `aa1e158`, `57a1d1f`, `3c97a2c`, `49c06bb`, `2a9a94d`, `665130a`, `f27221b`, `f70fc53`, `2f23586`, `ed7b5ae`, `277a222`, `1e067e8` feat(orientation, intake, surfaces): orient only the systems the charter names and pick each role's queues; read intake scope candidates per page and ground each pick; propose a documented system the charter does not name; read only the approved intake scope; the card shows what each employee reads and the systems the charter leaves out
- `3cdda04`, `9d41d0e`, `e1db54c`, `1f3db74`, `e034296`, `de7edce`, `f319ce3`, `24d5851`, `7ba804c`, `cf9d6b3`, `1e33957`, `8a275a1`, `00c910d`, `f9c7d64`, `03ec4e6`, `9f7e81e`, `f62b294`, `08045dc`, `bfa65b6`, `814fd74` feat(surfaces): replay a run's sign-in on the adapter's browser before an invocation's first call, authorised under the authority it first landed with; a page is open only once a replay or a call has landed on it; replayed calls count toward the audit trail and not as automatic actions; resolve an element by whole words
- `af97b6a`, `9e0198e`, `8403051`, `491fcc6`, `b938306`, `b5ab82d`, `52d19f4`, `549b674`, `3cb8751`, `f2e3c38` fix(work, surfaces): read the carried reads again when a retry resumes at the closing phase, take a resumed set's reads and never reuse them, mark re-read and superseded rows in the closing prompt's ledger; hold a message that follows a write that did not land; sign a resumed run in from the ledger it resumed
- `a6537aa`, `d2dc1ed`, `32c6063`, `7934da1`, `b73647f`, `df96f1f`, `644c170`, `ca2c123` feat(skills): verify one authored skill at a time through a `sandboxLeases` row, for the serial bundled sandbox only, with a five-minute deadline; retry a parked verification without re-authoring
- `b763b38`, `df991b2`, `bdf4390`, `9c98ac9`, `c3c1eb9`, `35b4fb4`, `9cc6e6b` feat(model, compose): count the provider requests a model call sent and report each call's attempts, duration and outcome, on the item's events as `work.model-call`; run the backend scheduler wide enough for three employees at once; keep telemetry and diagnostics secret-free
- `47ae3bd`, `e06a6f8`, `0244bf5`, `6844582`, `448ad97`, `ef73cd9`, `43e88e0`, `b02b2af` fix(redaction): never take a channel reference or a dotted name for a secret; treat a camelCase word as a runbook word; keep identifier keys out of credential assignments; widen assigned partial secret spans and retain long opaque secrets
- `b1b585e`, `8062897`, `331de81`, `6886dd5`, `01b34e8`, `414a7f5`, `f9f3656` fix(metrics): order events of one millisecond as the backend wrote them, so the figures do not depend on the order rows are read in; exclude manually stamped revocation trials and the generated evaluation identities
- `7d747bf`, `db363f0`, `2520cea`, `4c16983`, `c945a8c`, `cf11662`, `df9588b`, `a87fc19`, `4eb62fd`, `8aeb287`, `0138d2a`, `173ed32`, `29b57a8`, `57ef14a`, `b205928`, `971ad35`, `cff5d07`, `0b6c1e6`, `e83e13a` feat(bed): the company bed, `pnpm bed:company docs, check, seed, post and teardown` and `./setup.sh --company`, with its pages, tickets, Slack asks and the manager's answers; a named set of tickets seeded and checked
- `8167b0f`, `45fdb36`, `0e5d11d`, `8a64fc2`, `d350204`, `e41ed44`, `ae1d458`, `92a6ba1`, `c012f68`, `7f6bd93`, `4b14e96`, `204280f`, `afaf1d3`, `f842616`, `bb705dd`, `4eabb98`, `1226e26`, `8bb463a`, `a10a882`, `8898a82`, `f48cc59`, `c989b8c`, `e8f2f9e`, `5491ce4` feat(demo-bed, revocation): the revocation kit's rung refuses without the redactor and seals its evidence; the redactor starts from a warm volume clone; snapshots need a checksum, are confined to the kit directory and are discarded if the backend restarts; protected projects and warm sources refused before Docker
- `f1f35a7`, `99414ff`, `75d85a1`, `fc4b9ca`, `3be2788`, `bdb908c`, `609c2c9`, `27b6c32`, `53249b0` fix(surfaces, charters, agents, documentation): reopen approval when a documented queue changes and ignore quoted queue labels; check invites for the approved channels only; retain the approved role after a draft rejection and refuse changes to approved or stale drafts; clip roles on Unicode boundaries; clear the locator when a source kind changes
- `d74d6ac`, `32197b5`, `14a4f9e`, `b26221c`, `0ad685d`, `6f4658e`, `f768f96`, `6f8e6b0` docs(running, readme): the backend's entry points and where concurrency is set; the components, ports and knobs the merged compose starts; the evaluator's seven criteria, the six grants a deploy seeds, the 21 tables a reset clears
- `8fa739d`, `6635979`, `1831d65` fix(setup, probe): the company check fails on non-token gaps and runs quietly

### 17 September 2026

- `e6a9807`, `5bd1fe1`, `52d90b0`, `aaa8978`, `49b0375`, `fccb167`, `65be688`, `c63a3d6`, `de5952a` feat(setup): `./setup.sh` is the one entry, real mode by default, with a local or Featherless model route, a model picker on the local route, and stop, resume and clear verbs; `--reset` does not read its own ports as taken
- `c570265`, `181ba4a`, `275f799`, `766d77b` feat(setup-page, landing): the three ways to run it by the deck's names, real mode's first success; Try the demo goes through sign-in to the hosted mock office and the recording gets its own button
- `561e6b5`, `4fc50f7`, `030c6fa`, `454a611`, `c8ca560`, `5d1a2ff`, `7c44291`, `2c5b528`, `d63da6f` docs(readme): the three ways to run it with real mode as the local route, each run section opening with its one command; the disclosures, the evidence map and the interface pointer; the recorded run and demo video are the 17 September recording, both halves
- `0f0d8a1`, `38c0bd2`, `d9254c5`, `27d80ad` docs: this changelog, the security policy, the reuse interfaces page, the contribution guide with issue forms and a pull request template
- `bb18035` chore(evaluation): remove the 14B local bed and every mention of it

## goai-final: the finals build, 4 to 16 September 2026

The tag `goai-final` stood at `5fac642` on 16 September 2026 and `day0-olive.vercel.app` was deployed from it; both moved on with the entry above. 440 commits dated 4 to 16 September.

### 16 September 2026

- `6a44d8d` feat(plan): declare per-step obligations and the transition, settled by the plan-obligations judgement in real mode
- `2b80b5c` refactor(gates): verify the declared obligations against the ledger and delete the plan-step prose classifiers
- `34a30c2` feat(obligations): hold the ticket state change when either the planner or the judgement leaves it to the manager
- `bf6ca13` feat(hold): a retry note that directs the ticket state change in so many words lifts the hold for that retry
- `e7a0772` feat(card): show what the approved plan declares it owes, and when the judgement could not settle it
- `fd4ef22` feat(audits): fail soft after the one repair, keeping the rest of the response
- `50c8f3c`, `3e04c9b`, `c4e01d0`, `e68427f`, `f938d46`, `383f6b9`, `a443bb7` fix(executor, evidence-claims): check phase-one messages and DMs against the evidence; refuse a closing message that asserts a fact no evidence carries; let a message cite the writes earlier runs landed
- `53ab15e` feat(skills): keep a refused skill draft on the row and show it under the failed skill
- `d7beabe` feat(skills): hand the refused draft back to the retry and ask for one corrected replacement
- `194c367` fix(charter): file the evidence guard's note under synthesis notes, never as an open question
- `73b1a45` feat(rehearsal): add `--headed` so the operator can watch the script drive the dashboard

### 15 September 2026

- `c68dee4` feat(charter): identify the constraints a charter draft carries
- `39be712` feat(charter): strike a constraint before approval
- `8329107`, `a7723b6` feat(dashboard): confirm or strike each rule on the charter card; preview each strike and disable one approval would refuse
- `b2656b6` feat(charter): amend an approved charter as a new version
- `eac3f84` feat(dashboard): amend the charter from the card
- `27e70ca` feat(charter): an amendment re-evaluates parked work through the intake trigger, keyed on the new version
- `21d0c19` feat(charter): ask each open question once, at the first plan that touches it
- `1b720b0` feat(work): answer the plan's questions with the approval, as one decision
- `1e75c66` feat(work): judge scope once, with the lexical rule and quality fit as inputs
- `65ce15e`, `51d7604` feat(work): Retry an item skipped as out of scope, recorded as the manager's waiver; waive the eligibility rule on that retry
- `bc152a2` feat(work): re-admit parked work when the policy it was judged under changes
- `82a4974` feat(docs): re-admit out-of-scope skips when a synced page changes
- `41e8df7` feat(intake): carry the owner and the requester on the candidate
- `7f419f6` feat(intake): poll a surface the moment it first connects
- `43765a9` feat(work): ground a chat ask's plan in its thread
- `fdcb412` feat(work): name a proposed skill by surface class and operation
- `e953acb` feat(work): match a registered skill by shape before any token score
- `889a469` feat(skills): author a parameterised procedure with invoke conditions from the runbook
- `b3603c4` feat(work): bind a skill's declared inputs from the candidate at execution
- `7eb8403` feat(skills): refuse an authored body that carries the first work item's values
- `d297ff0` feat(skills): retire a registered skill that predates shapes
- `8794672` feat(work): repair a held write's argument names once before the hold
- `2d54739` feat(work): audit fixed-payload writes on MCP and HTTP surfaces for deferral
- `dca6fb0` feat(work): retire the last-read truncation and refuse prewritten closing actions in the audit
- `7d31186` feat(work): size the closing cap to the runbook closing set and one deferred sequence
- `529a75b` feat(work): a run that lands nothing and leaves nothing to decide stops, and pages no one
- `265595a` feat(work): the gate tells the manager what landed, per run or in an hourly digest
- `6dca664` feat(work): approve held actions across items from one place and with one channel code
- `4a0c388`, `b803268` feat(work): keep the manager's feedback on the item and show it on the card; a fact the manager states is evidence for the plan step it settles
- `06bb43b` feat(redactor): compose component serving span-model spans
- `ddf9ea6` feat(redaction): model-backed redaction with the entity policy as data
- `47d5099`, `7ca0303` feat(credentials, redaction): owner-scoped known-value source for exact redaction; owner-wide exact-value removal at every persistence boundary
- `9a3436a` feat(redaction): checksum-verified national identifier in the grammar
- `27b10ac` fix(ui): distinguish provider evidence with limited redaction
- `32770df`, `87534c9`, `21a1d98` feat(rehearsal): `pnpm rehearse:real` with the phase list and the dry-run boundary
- `8acb551` test(convex): give the 60-page documentation sync its own timeout

### 13 to 14 September 2026

- `d03d355` feat(work): render probed tool argument names to the executor and skill author
- `45d2ad7` feat(work): make a ticket from a connected, named surface eligible by provenance
- `6e6645a` feat(work): repair a read the provider refused for its arguments once
- `52cbaf3` feat(work): treat charter adjectives as scope, not verification gates
- `7bb5c62` feat(work): read the candidate's record before drafting the plan
- `f6a8655` feat(work): defer phase-one work by data, not by judgement
- `9054410` fix(app): tell an unconfigured build to rebuild, not restart
- `cd5822d`, `887f72a` feat(landing): staggered entrance and scroll reveals; animate surface discovery and packet flow
- `f3c9c25`, `df18962` feat(setup): reveal sections and sticky guide navigation

### 12 September 2026

- `23a2261` feat(setup): add `pnpm setup:local` for a local installation
- `f4b2543`, `0fca153` feat(setup): put the quick-start commands in one tracked file; the setup guide at `/setup`
- `bf4e879`, `6d0b2eb` feat(demo): render the recorded walkthrough at `/demo` from a sanitised hosted-demo snapshot
- `e12db77` feat(landing): route a signed-out visitor to the demo and to setup
- `ada53c6` ci: add the repository gate workflow
- `d5972fe`, `79a1dc6` feat(model, voice): configure output budget and reasoning effort; thread them through the chat route
- `e4ca015` feat(evaluation): record output settings in harness parity
- `384ca50`, `521d7cb` feat(docs): redact cloud, payment, JWT, Bearer and connection-string credentials; floor labelled values on entropy
- `a9238e8` feat(credentials): delete the ciphertext on reset and on unlink, keep the row
- `976b497` feat(dashboard): show decisions by dashboard versus phone on the Supervision card
- `20dd7f9` feat(work): resend a phone decision request the send never confirmed
- `2844108`, `eb8f3da` feat(scripts): the demo bed kit; a restored volume answers to the file, not to the recording bed
- `cd3a588` feat(scripts): the mainland-China arrival connectivity probe
- `5b2e5ca` feat(audit): compare hosted demo exports offline
- `8ca85af` build(compose): pin every image to its digest and cache the Notion component's npm fetch
- `a456448` build(tsconfig): exclude the ignored docs tree from type checking
- `0e6f229` fix(dashboard): render the active pill from the shared supervised label
- `f825522` chore(docs): untrack the private planning and research documents
- Evidence: `4c7601d`, `25206c6`, `cde210c` docs(evaluation): the GLM 5.3 Flash paired bed (`2026-09-12T06-33-21Z-v4-glm53flash`), its revocation containment set, and the re-bed with prompt-mode schema repair (`2026-09-12T07-54-47Z-v5-glm53flash`); `40c166e`, `44de4f5`, `8724063` the baseline-only GLM route check (`2026-09-11T20-08-51Z-v2-glm53flash`) and its provenance; `faf4365` cite the 2 September revocation trials

### 4 September 2026

- `e1cb539` chore(docs): untrack internal planning handovers from the public repo

## Semi-final freeze, 2 to 3 September 2026

Submitted snapshot `cc4e7a5`, 3 September 2026 (no tag). The recorded real-mode run and the README's documented run are both on `a41fd94`, 3 September. 89 commits dated 2 to 3 September.

### 3 September 2026

- `cc4e7a5` docs(submission): publish the data-source and compliance statement
- `c2ca7c7` docs(readme): one full real-mode run and its README section, 16 screenshots
- `2ffeaa0` docs(readme): set the manager email in the real-mode setup, which Slack needs
- `abb0f0b` feat(model): default to `gpt-5.6-terra`
- `9ff6334`, `19f6369`, `91285d1` feat(work): let the manager retry an item the quality-fit filter skipped; let a note travel with Retry as manager feedback; let the manager send a completed run back with a note
- `ccda063`, `6c2c215` feat(work): plan from the connected surfaces and the loaded documentation; give the closing phase the loaded documentation as citable evidence
- `00b4ebd` fix(discovery): treat the catch-all class as no evidence against a match
- `8859ffc` chore(git): ignore local `.env.local.*` variants

### 2 September 2026

- `63817f0` feat(evaluation): standardise harness v2 (300 s call abort, 15 min task deadline, six authoring attempts, local sandbox required)
- `6aa05a9`, `0cfbb5e`, `0dd4f4e` docs(evaluation): define the harness v2 evidence boundary; the three frozen beds `2026-09-02T08-35-22Z-v2-qwen8b`, `2026-09-02T13-59-20Z-v3-terra`, `2026-09-02T14-28-33Z-v3-sol`
- `7dc1f0d`, `c18e589` feat(work, ui): reconcile provider effects before retry; the provider reconciliation control
- `8f9d84c` fix(discovery): build documented endpoints without URL setters
- `10d1e5b` feat(ui): cursor toggle for recordings
- Revocation trials: `evaluation/results/revocation-2026-09-02T12-17-54Z/`

## Real mode and the controlled evaluation, 25 August to 1 September 2026

No tag. 407 commits dated 25 August to 1 September. The real-mode surface layer, the exact-action gate, credentials and redaction, the evaluation harness and the first frozen beds.

### 30 August to 1 September 2026: the evaluation harness

- `29d2900` feat(evaluation): add fixed tasks and programmatic graders
- `d59a92c` feat(evaluation): add ordinary-agent control arm
- `5431e18`, `fdbafe5`, `de3f5d1`, `3728c1a`, `1dcf75d` feat(evaluation): gate day0 mock writes; expose task seeding and grader snapshots; share non-zero model temperature; the evidence report contract; timestamp the first correct task effect
- `30d4404`, `8dc77cc`, `48e630d` feat(evaluation): the resumable semi-final driver; record the backend's model and write each run to its own directory; regrade retained evidence without models
- `1f0354a` feat(evaluation): measure exact-action gate accuracy
- `bd85d15` feat(evaluation): add live revocation harness
- `f768d9e`, `3a791c0` feat(evaluation): recognise documented procedure effects; score documented procedure adherence
- `88cdddc`, `dfffeab` feat(evaluation): retain value-free action audit; report action binding evidence
- `389da50` feat(work): enforce runtime procedure trails
- `1d67364` feat(permissions): add audited scope revocation
- `cf0dcde`, `0b9040f` feat(metrics, dashboard): quantify supervision and permissions; surface the metrics on the dashboard
- `07366be` feat(evaluation): persist comparison arm per agent
- Evidence, harness v1, superseded and kept as audit history: `ee472b5` to `6b68666` (30 August to 1 September), `9a43b24`, `b856957`, `4282234`; revocation set `revocation-2026-08-30T09-52-46Z/`

### 25 to 29 August 2026: real mode

- `ad80f21`, `71b5c29` feat(docs): link and mirror documentation sources; expose agent source inheritance
- `f9ee4b9` feat(surfaces): orient named systems from team docs
- `9d826f3`, `ccf93cb` feat(discovery): derive systems from synced documentation; show system discovery provenance
- `f17798f`, `b43e48e` feat(probes, setup): backend surface verification; report real surface readiness
- `b72a3dd` refactor(surfaces): extract mock adapter registry
- `bec1167`, `abf5cf6` feat(work, surfaces): the `mcp.call` and `http.request` verbs and their apply-time rules; the MCP and HTTP adapters behind the registry
- `538220b`, `dc3a9d8` feat(work, dashboard): the exact-action gate between the skill run and apply; the gate and the three-way ledger on the dashboard
- `9e87bb9`, `533c5d0` feat(skills, work): target a surface and refuse approval until it is connected; gate evaluation on connected surfaces
- `5198da5` feat(surfaces): connect and poll documented systems
- `ab6be28`, `7565abe`, `1d8a0fe` feat(credentials, documentation): the encrypted credential contract; redact and batch source syncs; credential controls and probes
- `d3ee41e`, `28b1268` feat(surfaces): a labelled shared-token fallback landing on OAuth surfaces; persist the credential kind on the surface row
- `5235937`, `9645d49`, `bf4d2f8` feat(work): the posture ladder per action class, then replaced by one autonomous-actions switch; tell the executor and the skill author about the switch
- `d0211f7` feat(work): emit public replies as threaded `chat.postMessage` actions
- `4131a8c`, `3897a12`, `f891de6` feat(work): approve plans under autonomous actions; request and resolve decisions in the manager channel
- `6a53353`, `6cd119f`, `c04a76f` feat(surfaces, slack): read app manifests from the docs and sign install state; let an employee provision and install its own Slack app; the isolated provisioning proof service
- `a373b20`, `707148a` feat(surfaces): drive a web-UI-only system through the browser floor; make the browser component optional
- `0e0f63a` feat(docs): make the Notion documentation component optional
- `484652c` feat(dashboard): describe each held action in plain language
- `1ac293c` perf(intake): read chat rows by index for the minute-by-minute decision poll
- `29536b6`, `253c196`, `d247d15`, `b152a54`, `cfb1b0c`, `45ee96c` fix(surfaces, discovery): the evidence-backed fallback ladder; keep the browser rung on documented evidence; judge documentation by its evidence

## Standing as an open-source project, 12 to 13 August 2026

No tag. 122 commits dated 12 to 13 August. The account-free route and the local sandbox.

- `b8f31bc` feat(model): support any OpenAI-compatible endpoint via `OPENAI_BASE_URL`
- `ee00718` feat: add a self-hosted Convex backend for local development
- `23a9daf`, `f3e5ab7` feat(dev-auth): a no-auth development mode behind a fail-closed flag, gated on a locally held key
- `2290660` feat: give the account-free path a model the backend can actually reach
- `dc93596` feat: reserve the GPU for the bundled model service by default
- `b724570`, `ffe53cc`, `3ed8779` feat(sandbox, skills): bundle a local skill-verification sandbox service; choose a verification sandbox behind `authorAndVerifySkill`; harden the sandbox
- `8f9df2e` feat(vendors): degrade gracefully when Exa or Daytona keys are absent
- `2586105`, `0d4d7fd` feat(voice): make the chat-only deployment shape explicit; declare the ElevenLabs webhook secret and check voice setup
- `a49dbf4`, `6b9021a` feat(scripts, check-setup): check the whole local setup, and read env the way the app does; report sandbox verification as a fifth setup
- `97b0f06` build: run eslint directly and add a model-endpoint probe
- `0736d94`, `8b555b0` feat(charter), fix(onboarding): reject evidence that quotes the agent as the manager; build charter answers only from the manager's turns
- `a3da388` merge: require a signed-in caller on the provider-funded voice routes
- `507fe00`, `c545367` feat(icon, og): a browser tab icon; a link preview card
- `9ce0219` docs: show the product in the README, restructure to run-first
- `986fd6d` docs: credit the source of the pixel-art builder avatars

## Hackathon build, 9 May 2026

No tag; last commit of the day `2d4b82c`. 42 commits dated 9 May, at the AI Engineer Hackathon, Singapore.

- `02b9ddd` feat: scaffold Next.js 16 and Tailwind v4 shell
- `1356dd3` feat: add Clerk auth with sign-in and sign-up routes
- `55adeb5` feat: Convex foundation with full schema, auth bridge, agents and reset
- `01bf0ba` feat: agent foundation with charter synthesis, Day-1 prompts, good habits
- `11fdeba` feat: voice API routes (ElevenLabs start and webhook, chat, onboarding synthesise)
- `c9fcead` feat: complete Day0 with work loop, skills loop, mock environment and dashboard
- `92f672b` feat: enforce per-account ownership across all agent-scoped functions
- `6343e60` feat: generate role-specific work items from the charter instead of a hard-coded demo seed
- `5777d93` feat: push-to-talk voice mode
- `af4d52e`, `2d712a8`, `db3ddd1`, `536fbd2` feat: pixel-art agent avatars, selectable; the mini office world
- `c66df6b` fix: rename `work.seeded` to `work.discovered`
- `464ca73`, `5ac31a8`, `51eb420`, `2d4b82c` fix: guard verdicts on non-evaluable items; align slugs and instruct the skill author to emit actions; feed the live mock environment snapshot to the work generator
