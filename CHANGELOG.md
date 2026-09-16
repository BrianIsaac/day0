# Changelog

Version maintenance record for Day0, from the git history, grouped by the milestones the project has shipped against. Day0 has no semantic-version releases; each milestone is a named commit, and `goai-final` is the only tag. Hashes are the commits on `main`, 1,100 of them at `goai-final`; a merge of a job branch is listed by the substantive commits it carried, and counts are by author date. Every commit follows conventional-commit style, so `git log --no-merges --format='%ad %h %s' --date=short` is the full record and this file is its digest.

## goai-final: the finals build, 4 to 16 September 2026

Tag `goai-final` at `5fac642`, 16 September 2026. Hosted at `day0-olive.vercel.app` from the same commit. 440 commits dated 4 to 16 September.

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
- Evidence: `4c7601d`, `25206c6`, `cde210c` docs(evaluation): the GLM 5.3 Flash paired bed (`2026-09-12T06-33-21Z-v4-glm53flash`), its revocation containment set, and the re-bed with prompt-mode schema repair (`2026-09-12T07-54-47Z-v5-glm53flash`); `40c166e`, `44de4f5`, `8724063` the baseline-only GLM route check (`2026-09-11T20-08-51Z-v2-glm53flash`) and its provenance; `faf4365` cite the 2 September revocation trials and the 14B counter-result

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
- `6aa05a9`, `0cfbb5e`, `0dd4f4e` docs(evaluation): define the harness v2 evidence boundary; the three frozen beds `2026-09-02T08-35-22Z-v2-qwen8b`, `2026-09-02T13-59-20Z-v3-terra`, `2026-09-02T14-28-33Z-v3-sol`, and the 14B bed `2026-09-02T09-40-48Z-v2-qwen14b`
- `7dc1f0d`, `c18e589` feat(work, ui): reconcile provider effects before retry; the provider reconciliation control
- `8f9d84c` fix(discovery): build documented endpoints without URL setters
- `10d1e5b` feat(ui): cursor toggle for recordings
- `b5519cc` docs(evaluation): retain qwen3 14b serving evidence
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
