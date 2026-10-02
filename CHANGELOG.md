# Changelog

Version maintenance record for Day0, from the git history, grouped by release. Releases are tagged with semantic versions from 27 September 2026: `v0.1.0` is the build of 19 September 2026, and the work before it is grouped by date under "Before v0.1.0"; each engineering wave that reaches `main` takes the next minor, a hotfix on a release the next patch, and `v1.0.0` is the pilot release. Hashes are the commits on `main`, 1,607 of them at `f739614`; a merge of a job branch is listed by the substantive commits it carried, and counts are by author date. Every commit follows conventional-commit style, so `git log --no-merges --format='%ad %h %s' --date=short` is the full record and this file is its digest.

## v0.14.0, 3 October 2026

Wave 11: access. IT connects each system to Day0 once, at install; the manager approves each
employee's access on its card knowing whom the employee will act as; the employee acts as itself
in each system; and ending access revokes at the vendor what Day0 obtained, never a key someone
pasted. Twelve units, one pane each (the schema step first, then the organisation's connections,
the ends of access, the MCP authorisation, the install kit, Slack, Linear, the token store, the
card and its screens, the joins, and two fix units beside them), landed on `staging` with CI
green on every unit branch and the gate on the combined tree, reviewed as one change on three
beds (the release pushed over a `v0.13.0` volume in real mode, the hosted shape, and a
customer-local install against fakes of Slack, Linear and an MCP server), plus the fixes that
review asked for before the tag. 246 commits; 9,002 tests.

- **Whom an employee acts as (11-AC, 11-AK).** Every connection card says, before the manager
  approves, whom the employee will act as in that system: its own app, the organisation's shared
  app with Day0 recording who did what, the manager's own delegated grant, or a key someone
  pasted, with a warning chip beside the last two. After an end, a card that holds no credential
  names no identity it no longer has.
- **The organisation's connections (11-AO).** Administrators named at install
  (`DAY0_ADMINISTRATORS`) land, rotate and revoke the organisation's connection to each system on
  the organisation page, and approve no employee's access. A revoke ends every card on the
  connection with the administrator's reason, which the card shows first. A card whose system IT
  has not connected drafts an access request for IT (Copy, Email it), with how to connect it and a
  link to the right place on the organisation page.
- **The install kit (11-AI).** `./setup.sh install` runs the sign-in, the access half and a live
  sign-in check in one go (about 3 min 50 s measured from a clean clone with three systems);
  `./setup.sh access` lands each system per employee or shared, secrets by hidden prompt or
  `--secrets-stdin`, never on a command line; `./setup.sh access --correct <system>` records a
  redirect or scopes IT fixed at the vendor; `pnpm check:access` checks each connection with its
  vendor. Recipes for Slack, Linear and an MCP server in `docs/running/`, held to the kit by tests.
- **Slack (11-AS).** From a configuration token IT generates once, Day0 creates each employee its
  own Slack app; the configuration token pair is renewed before use. After a
  renewal the employee re-joins its public intake channels itself; private channels are re-added
  by hand.
- **Linear (11-AL).** Shared: one app user for every employee. Per employee: an administrator
  records each employee's own app from its access request and installs it; the employee's tickets
  are those delegated to its app user.
- **An MCP server's authorisation (11-AM).** The manager connects a card through the
  organisation's registered client with OAuth 2.1 and PKCE; the employee then acts with the
  manager's own delegated consent, and only that manager, signed in, can finish the authorisation.
- **Ending access at the vendor (11-AR).** Disconnect, retire, a handover's cut, a rejection and an
  administrator's revoke each revoke at the vendor what Day0 obtained (a token, a grant, an app),
  write the result on the record, and retry a vendor that does not answer; a pasted key is left as
  it is and said so. A revoked or rotated organisation secret is deleted. A handover keeps an
  employee's own identity for one re-approval by the new manager.
- **The token store (11-AT).** Nango, under its own opt-in compose profile `token-store`, keeps
  and refreshes the OAuth tokens of an API-rung system Day0 has no issuer of its own for.
- **The joins (11-AJ).** The organisation's ledger joins the audit export and the exported trace.
- **The hosted demo's walk (11-FD).** An adoption is offered in the mock office when a second
  employee's ticket needs a skill the first has verified; the first approval waits up to 180 s for
  a cold sandbox; "Delete my data" sits on a "Your data" card whenever anything is stored; a
  handed-over employee's decisions read "since you took over"; the sign-up tab says "Create a
  Day0 account".
- **Recorded items (11-FI).** An intake sweep skips an employee handed over since it read the
  cards; the adoption fit asks the charter about the system, not its class; a write Linear answers
  with its exact 502 is resent once; the record says when the named manager could not be told in
  Slack, and why; a provider that does not answer reads "did not answer"; the employee page's title
  is right for a link to another account's employee or one that is gone.
- **From the review.** A key found in the documentation is never bound where IT's connection
  covers the system ("Key in your docs: Found and not used"), and is stamped a shared key where
  none does; a handover's cut revokes at the vendor as a Disconnect does; every revocation call
  meets the address rules; only the card's manager completes an MCP authorisation, and a second
  person who tries is told nothing was connected; renewal offers the move to IT's connection for
  a pasted-key card; a shared token's end writes the shared line and revokes nothing the others
  use; an MCP token refreshes with the connection's current secret; a confidential MCP client needs
  its issuer; the install says why it stopped waiting for the app; the runbook corrected in six
  places; Deploy and the documentation link get 44 px targets.

**Upgrading from v0.13.0.** A hosted copy upgrades with `./setup.sh cloud upgrade --target
<file>` from a checkout of the tag; nothing needs setting on a hosted deployment. The schema
gains two tables (`organisationConnections`, `connectionEvents`) and optional fields on existing
ones; two migrations, `surfaces-acts-as` and `credentials-issued-by`, stamp whom each connected
card acts as and which credentials Day0 obtained, run once and change nothing when run again
(they change nothing on a deployment with no connected card). Exported traces are format version
5 (versions 2 to 4 are still read). New environment names, all customer-local:
`DAY0_ADMINISTRATORS`, and for the opt-in token store `DAY0_NANGO_URL`, `DAY0_NANGO_SECRET_KEY`
(both pushed to the deployment), `DAY0_NANGO_ENCRYPTION_KEY` and `DAY0_NANGO_DB_PASSWORD` (which
stay with the compose file). A private MCP server's host goes in `DAY0_PRIVATE_HOSTS`, as before.

**Not in this release.** No real Linear or Slack workspace has yet seen an app actor, a revoke or
a rotation: every vendor leg ran against fakes. Per-employee Linear's last step opens linear.app
and was not pressed. The company sign-in is still unchecked against a real Entra, Okta or Google
tenant. The first approved ticket run in the mock office still stops, as in v0.13.0.

## v0.13.0, 2 October 2026

Wave 10: skills shared between a manager's employees, and signing people in through the company's own identity provider, with the handover's real-mode hardening and the findings of the signed-in walk of `v0.12.0` beside them. Six units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change on three beds (the release pushed over a `v0.12.0` volume first, the Skills tab and a handover between two accounts, and a company sign-in in real mode), then walked on a real Linear workspace, plus the fixes that review asked for before the tag. 196 commits; 8,077 tests.

- **The skill library (10-K).** Every skill an employee writes and the sandbox verifies is kept as a numbered version in its owner's library, with the check that passed; a registered card says how often the skill has been used. A handover copies the versions the employee holds into the new manager's library and nothing else; a retire keeps the owner's versions.
- **Adopting a colleague's skill (10-A; A3, and A14 ruled 1 October).** When an employee needs a skill another of the same manager's employees already holds, the proposal offers it: Adopt, Write a new one instead, or Decline. Adopt grants only the scopes the adopter lacks, and the sandbox checks the skill again under the adopter's own connection and approved tools before it runs; the card then says whose version it is. The company figure for skill reuse counts adopted runs and shows them apart.
- **The five controls (10-C; A12 and A13 ruled 1 October).** A skill shows Re-check due with its reason (a newer version, a changed tool list, a connection made again, a check that was not kept) and Re-check now, which also moves a holder onto the newer version; it keeps running unless the check fails. Ask for a revision writes a new version beside the running one. Retire takes a skill from one employee, and Withdraw takes a version from every employee who runs it, stops its runs and ends the adoptions that offer it. A failed draft says which of its three attempts it is on, and Give up ends it and cancels the work that waited. Nothing is re-checked on a timer.
- **The company sign-in (10-S; A7, and B5 ruled 1 October).** Under the customer-local profile people sign in through the company's own OpenID Connect issuer: `./setup.sh sign-in --provider entra|okta|google|oidc`, a guide for each, `pnpm check:setup` saying whether it is configured correctly and `pnpm check:sign-in` checking a live sign-in claim by claim. Who may sign in is decided three times: the provider's own assignment, the allowed domains checked at the callback and on the backend, and a verified address to deploy or take on an employee. The session is a sealed cookie; Clerk is never loaded under the profile, and stays the hosted demo's.
- **The handover in real mode (10-FR).** Nothing an orientation, an intake poll or a plan read under the earlier manager lands on the new one; a connection card that moves loses the earlier manager's probe reasons, documented address, credential location and drafted prose; while a handover is accepted and its runs end, the earlier manager can no longer grant, approve, adopt, revise, turn autonomous actions on or approve or amend the charter; a handover that cannot finish ends itself and says so on the record and on the acceptor's home; a deletion scrubs a request's note and decline reason.
- **The walk's findings (10-FW).** The earlier manager's home and link say what became of a handed-over employee since, for thirty days, with no error in the console; the retire dialog names the handover requests it keeps; the charter and the record name the manager who decided before a handover, never "you"; `/setup` names the hosted demo's address; the one-to-one closes with one thanks and what is still open; a Review link survives the sign-in; an exported trace carries its employee's handovers, so figures recomputed from traces are cut by tenure.
- **From the review.** No copy of a skill crosses owners at a handover, and a withdrawn version can never register again; an adoption is drawn by one card; the voice start route works under the company sign-in; a trace names no earlier manager's account; Give up releases its claim on the provider's item; the Skills badge counts every skill that waits on the manager; the approve and retry buttons keep their contrast under the pointer on every ground; a new skill's first draft is no longer aimed at a chat connection the employee does not have.

**Upgrading.** A hosted copy upgrades with `./setup.sh cloud upgrade --target <file>` from a checkout of the tag. The schema gains one table (`skillVersions`) and optional fields on `skills`; two migrations, `skills-library` and `skills-use-count`, run once and change nothing when run again. Nothing needs setting on a deployment: shared skills is on unless `DAY0_SHARED_SKILLS` is set to `false`. **Every skill registered before this release reads "Re-check due: its check was not kept" until it is re-checked**; Re-check now writes the missing check, at one model call and one sandbox run a skill. Exported traces are format version 4 (versions 2 and 3 are still read). The company sign-in's settings are written by its setup verb; the Clerk path is unchanged. Not yet checked: the sign-in against a real Entra, Okta or Google tenant.

## v0.12.0, 1 October 2026

Wave 9: handing an employee to another manager, with the findings of the signed-in walk of `v0.11.0` and the hosted demo's new address beside it. Eight units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change on a bed where three accounts handed an employee between them and the release was pushed over a `v0.11.0` volume first, plus the fixes that review asked for before the tag. 144 commits; 7,341 tests.

- **Handing an employee over (9-U1 to 9-U5; the rulings of 30 September: a manager change needs the new manager's acceptance, and the owner and the manager are one role).** A manager names a colleague's address on the People tab; nothing changes until that colleague, signed in with the same verified address, accepts on their home, where the request is a ninth kind of thing that needs them. The acceptance dialog says what comes with the employee and what does not before anything moves. At acceptance the employee is the new manager's: its record, charter, skills and lessons go with it; connections made on the old manager's credentials are cut and wait to be approved and connected again; the old manager's documentation is no longer read; a plan approved and not yet started returns for approval; a draft charter never approved is discarded for a fresh one-to-one; work already running is allowed to finish for up to fifteen minutes first. A request can be cancelled, declined with a reason, or changed to another address, expires unanswered after fourteen days, and is bounded per employee, per manager and per address. The old manager's home says where the employee went, and their figures keep the months they managed it.
- **The manager is the account (9-U1, 9-U5, 9-U4).** An employee reports to the verified address of the account that deploys it, read from the sign-in and never from the browser; the free edit of "Reports to" is gone. An employee whose address is not its owner's is flagged, and the owner hands it over or makes it theirs.
- **The walk's findings (F).** The Day0 mark sits above Clerk's card on every sign-in and sign-up step, the code steps included; on a phone the sign-in card is in the first screen, the hosted-demo notice folded under its heading before it; the chat one-to-one asks each of its seven questions once, in order, and names what was left open at the last; the cloud upgrade says its target was proved by a dry-run push and prints its rollback in the order it is taken; the browser job's port can be set.
- **The hosted demo's address (D).** The hosted demo moved to dayzer0.dev; day0-olive.vercel.app no longer answers. The README in both languages, the setup guide, the bug form and the page metadata follow it.
- **From the review.** A field name a real backend refuses is caught by a test over every function's validators and the schema; an employee's name is bounded, so no account can fill another's inbox; a finished one-to-one's words do not pass to the new manager; the manager who accepted sees an employee on its way after a reload; a returned plan drops the previous manager's answers; a flagged employee can be resolved before its first one-to-one; a write whose outcome is unknown keeps its claim; a handover that cannot finish can be ended by the operator; the first frame after a sign-in no longer says the sign-in failed.

**Upgrading.** A hosted copy upgrades with `./setup.sh cloud upgrade --target <file>` from a checkout of the tag. The schema gains one table and optional fields; no migration rewrites a row. Deploying an employee now needs a sign-in that carries a verified email address: a Clerk `convex` token template must include `email` and `email_verified`, and a customer issuer that sends `email` without `email_verified` is refused unless `DAY0_OIDC_EMAIL_TRUSTED=true` is set on the deployment. An employee's name is at most 80 characters.

## v0.11.0, 1 October 2026

Wave 8: the sign-in card and the one-to-one's presentation, the cloud deployment as one command, and the after-the-tag items of the v0.10.1 round. Three units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change on a bed and with the cloud verbs rehearsed for real from a fresh clone against throwaway targets, plus the fixes that review asked for before the tag. 94 commits; 6,833 tests.

- **The sign-in card and the one-to-one (Y).** The Day0 mark on Clerk's card and modals; one visible heading on every sign-in and sign-up step, and no console warning about Clerk's structure; the employee introduces itself by its own name in the one-to-one and in the mock office, and the model is given plain topic titles; the question counter says what it counts; the room fits the window, so the reply box is in view at a 1440 by 900 screen.
- **The cloud deployment as one command (D; decisions Q12, N10).** `./setup.sh cloud setup|upgrade|backup|pause|unpause --target <file>`: a first setup of your own hosted copy and an upgrade to the checked-out release, from a clean tag checkout, every change between the read that proves its target and the read that proves its result, secrets on stdin only, a backup export before an upgrade, a printed rollback, refusals for a wrong or development target, a dirty tree, a checkout off the tag, a Vercel project that is not a Next.js project, and a setup over a deployment the app already serves. The README's "Your own hosted copy" in both languages and the `/setup` page follow it.
- **The after-the-tag items (A).** A landing time on every landed write, so "Working since" is the write's own; the one-to-one room's session wiring in one hook and its tests off real timers; the sign-in gate pinned, with a walk of every owned read and a message after twenty seconds of waiting; the header's and the style layers' pins; runs ordered by when each began; the office floor in tiers with the first ten seats clear of each other; a charter rule listed once with Strike only where it changes something; the home headline tallying every state.
- **From the review.** `cloud setup` refuses a deployment the app already serves and a Vercel project with the wrong preset; the office seats re-ranked; the page heading demoted on the later sign-in steps; a strike that would change nothing is not offered; a refusal quotes its cause, not a stack frame; the README names the Featherless settings a hosted copy needs.

**Upgrading.** A hosted copy upgrades with `./setup.sh cloud upgrade --target <file>` from a checkout of the tag; the target file names the deployment, the app address and the Vercel scope.

## v0.10.1, 30 September 2026

The round after a signed-in walk of the hosted demo at `v0.10.0`: a one-to-one that survives leaving it, the header's account slot, the carry-overs from the first-week card, and the walk's own findings. Four units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed twice as one change on a bed, plus the fixes those reviews asked for before the tag. 102 commits; 6,557 tests.

- **A one-to-one that resumes (U).** The chat one-to-one is held on its session turn by turn: the manager's reply is kept before the model is asked and the employee's answer before the room hears it, the room rebuilds from the session on every open, the reply being typed is kept once it rests, and an earned close drafts the charter on the server with no tab open. Closing the tab, reloading, a crash or a lost connection at any question loses nothing that reached the server. A turn that never answers stops with Ask again.
- **The header's account slot (V).** The header holds the room of the sign-in controls, or of the account menu, from the first paint, so the site's links no longer move when the sign-in script loads.
- **The carry-overs (W).** A control's own focus style wins over the page's ring; a link in running text is underlined; the roster, the faces and the pill say "Drafting the charter" together; two modals open at once keep one hold on the page; the access default, an import cycle and a runtime import brought in line with the standard.
- **The walk's findings (X).** An employee page no longer fails when it loads before the sign-in has reached the backend; an employee at day zero or in its one-to-one can be managed and retired; a dropped space after an employee's name in built pages; the home's decision counts agree with the employee's page; every employee page has its own title; and the smaller copy and layout findings of the walk.
- **From the reviews.** A reply is filed under the question it answers, so a second window, a restart or a switch to a call can no longer misfile or mix a conversation; a reply whose send failed is delivered before the next, and Finish names it rather than dropping it; an owned page is taken away when the session ends elsewhere; "First supervised write: landed" and Working wait for a write that landed, not an approval; the phone office draws smaller figures, three across, and no desks.

**Upgrading.** The functions and the app deploy together. A chat one-to-one tab left open across the deploy is told to reload and carries on from the turns taken after it. An employee whose only approved write failed reads "after the first plan" again rather than Working.

## v0.10.0, 30 September 2026

Wave 7, at the operator's word after `v0.9.0`: the employee page's first week drawn as one card once the employee is working, the tab strip's scrollbar, the next shell pane's front-end half, and `/setup` stated from the deployment alone. Two units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change with a bed walk at classic scrollbars, plus the fixes that review asked for before the tag. 53 commits; 6,305 tests.

- **The first week as one card (S; the operator's ruling of 30 September).** Once an employee is working, the five-step rail gives way to one card the shape of a rail cell in the header, under the mode and state pills, taking no row of its own; pressing it grows the whole week out of the card over a lightly dimmed page, and any click or Escape shrinks it back into the card, interruptible either way, focus in and back, instant under reduced motion; the rail fades as the card settles when the week moves on in front of the manager. Every modal shares one focus and scroll-lock hook that keeps the page from shifting sideways under it.
- **The tab strip (S).** No scrollbar on the tab strip in a browser with classic scrollbars: the tabs no longer overflow the strip by a pixel, the page's scrollbar rules sit in the base layer so a component's own rule wins, the strip's line snaps to device pixels, and the selected tab is scrolled into view by the strip's own offset; a browser test with classic scrollbars pins it.
- **One set of words for an employee's state (S; review m6, decision N29).** The roster, the face's title and the pill say the state the employee's own page shows, read from the server; the page clock is a shared component; the record sets its times in a right-hand column where the line has room; the Skills tab's last authoring verdict survives leaving the tab; a skipped item in Needs you is one short sentence with the evaluator's reason one disclosure away and its own control; a refused private voice call is said in the manager's words.
- **`/setup` from the deployment (T; decision Q3).** The tracked demo snapshot and its display model are retired; the page states the release the deployment is stamped at, dated on the Singapore day, and nothing when the deployment does not answer; the landing no longer preloads a `/setup` screenshot it never shows.
- **From the review.** The open week draws no scrollbar of its own; a double click closes it once and never lands on a control beneath the dimmed page; Shift+Tab stays inside the week; the face says "Drafting the charter" with the pill; the rail's "All of the record" link and the record's payload summary hold their 44 px targets.

## v0.9.0, 30 September 2026

Wave 6 of the engineering plan: the product pages of the locked UX direction (round two's steps 2 to 12), which no earlier wave had carried, built as seven units, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change with a rehearsed walk of the employee page through a manager's first week on a bed, plus the fixes that review asked for before the tag; and one operations unit for the upgrade path. 172 commits; 6,243 tests.

- **The employee page is a shell with tabs (A; decisions N7, N29, N14).** The page names the employee, not the manager; a rail carries what the record and the figures say; the tabs are routes (Needs you first, then Work, Charter, Surfaces, Skills, Record, Manage, and People, Documentation and Reorientation as far as the backend exists), so an address names a tab and the Surfaces link and the Slack return still land where they did; Needs you lists what waits on the manager, longest wait first, from the same rule the company home uses; the day-zero state is the picker and what the employee knows so far; a gone employee's address says so instead of failing. The shared components every tab is built from (buttons, cards, chips, fields, disclosures, a dialog with focus trap and return, tabs with arrow keys, a live region for every mutation) live under `app/components/`; every Clerk surface is dressed in one appearance on Clerk's current variable names, so the hosted sign-in is readable.
- **The work item in its states (B; decision N7).** Discovered and skipped, plan to approve, working, write held for you, landed and landed in part, rejected by you, and the redraft: each drawn, each pressed by test through a live region with focus return; held writes withheld one at a time with the ticked count on Approve; the manager can dismiss a failed item out of the inbox, kept in the record; a stop whose write may have landed stays in the inbox until reconciled; what each Approve sends and what a retry reads is said as the gate applies it in either mode; every card carries an anchor the inbox lands on.
- **Charter review and the one-to-one (C).** The charter reviewed as one document with its rules, a rule that cannot be struck saying why, Approve counting the strikes; a draft sent back with a note is redrafted from the stored transcript by the same machinery every draft uses, and the approved record keeps what each strike took out; "Question n of 7" and the notes so far in the one-to-one, the drafting state surviving a reload (a reload had started a second conversation over the draft being written), Hold again as a server step, the provider's error text off the page.
- **Surfaces with expiry (D; decisions Q5, Q10, N29).** Each system as a card with its access end date, a renew control and the credential field the documented system needs, the field withheld until the card is approved; the cards' order and their drift judged on the server, so the browser no longer receives every cited page; a proposed card whose approval would be refused says so beside a disabled Approve; the mock office inside the tab on a phone-safe layout, opening on the channel where asks arrive.
- **The record and the skills (E; decisions A2, Q14).** Every event the contract lists said as one plain sentence in the manager's terms, paged by filter, with Export; what the employee knows projected on read from its rows, bounded, never a prompt input; the skills tab with proposals, registered skills and the refused line of a failed check marked, Retry withheld while a run writes the skill.
- **Manage, retire, people and documentation (F; decisions Q15, N1, A1, A5).** Retire through a dialog with a preview of what it revokes, deletes and keeps and a typed confirmation, apart from the owner's reset; the autonomy confirmation in the same dialog; the manager changed from People with what moves and where each name came from; the linked sources and a source's pages on the Documentation tab; and honest states, each naming the backend it waits for, where the design assumed one that does not exist yet (a per-employee pause, a light theme, people proposals, document authority).
- **The upgrade path (the operations unit; decisions Q12, N10, N19).** A resume changes only what its own arguments name or the file lacks (it had blanked the Daytona key on every re-run); the env sync removes the names it stopped managing; a deployment pause switch every scheduled job reads, set by the upgrade and by hand; the README's cloud upgrade names the rehearsed commands; a protected project's refusal in the verb's words; `/setup` states the release the deployment is stamped at.
- **From the review.** The gone-employee page reachable with an error boundary as the net; the redraft's sentence and pill true while it runs; a reworded intake queue line no longer disables Approve; the pause restarting the backend; the bed rehearsal driver rewritten for the tabs; the copy and component minors.

## v0.8.0, 29 September 2026

Wave 5 of the engineering plan: the UX direction locked on 27 September, implemented against `app/` as five units (the landing page and the motion module, the signed-in home, the dashboard's feedback and scrub with the first browser job, the walkthrough, motion on the product surfaces), one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change with a rehearsed walk of the public pages and a bed, plus the fixes that review asked for before the tag. 168 commits; 5,459 tests.

- **The landing page (L; decisions N29, N6, Q3, the UX lock).** `/` serves both audiences from one route: a visitor sees the marketing page (the hero and the orbit, the problem and the reasons, the four how-it-works steps as a pinned sequence whose active step follows the reading line, the evidence table dated to the run it reports, the closing ask), a signed-in manager the company home, and until the sign-in script has answered a neutral shell rather than the wrong page. The whip cursor is gone. Motion lives in one small module with a reduced-motion switch; the prototype's scroll assertions run against the real page as a browser test, and on short phones the frames sit inline above their copy instead of pinning.
- **The signed-in home (H; decisions N7, N6, N12).** The deploy form with the face behind a disclosure; a "needs you" inbox over one owner-guarded, bounded query, listing every decision the manager owes with how long it has waited, and now the one-to-one a deployed employee is waiting for; the roster as a table that stacks on a phone, each row carrying what it landed this month; the month grid in the manager's zone beside the supervision figures; the picker credited to its gallery with no real name anywhere; the office lighting up once, the first time it is seen, and drawing four desks on a phone. A failing inbox no longer takes the page down.
- **The dashboard's feedback, scrub and retry (U17; decisions N14, N29).** Every control reports its result in a live region and returns focus, through one hook; every failure path in the work actions scrubs the same way, so no stored, returned or logged text carries a token; the skips a rule does not waive have a Retry, and a question stop has an Answer control; a reset cancels every job it left scheduled; the strict plan, obligations and intake-pick schemas. The first browser job in CI: axe and a 44 px target check on the public pages at 1440 and 390, with known debt named per rule and control so anything new fails; the dashboard checked the same way under jsdom. Manager-facing copy says "employee"; the autonomy warning says "digital employee".
- **The walkthrough (W; decisions N29, N6, Q3).** `/walkthrough` replaces `/demo` (which redirects), built from the README's sixteen "One full run" steps by a generator that fails on drift, with the sixteen captures, the frame and clock over the same tracker as the landing, its own provenance line, and a full-size link for each header-strip capture; the sign-in page carries the notice of what the hosted demo collects, written from the README's own sentence, and says "employee".
- **Motion on the product surfaces (M; decision N29 UX 11).** The 1:1's newest turns rise in, a struck rule draws its line, a tab's count rolls, a work item's state chip swaps in place and a fresh landing settles, cards arrive in a short stagger and every moment leaves once it has played; the layout holds every page in one `main` landmark and page enter and exit are a View Transition, with the installed React pinned to the version Next runs so the tests render what the browser does. Everything is simply present under reduced motion.
- **From the review.** A signed-in manager's first second is a neutral shell, never the wrong page, and a visitor Clerk cannot reach sees the landing at once; one `main` landmark per page; the two skill-authoring refusals that spoke the raw envelope; the browser job's page list and its known debt keyed by node, now empty on every public page; the office light-up decided once the page above it has settled; a failing inbox loses only itself; the month card's "Held" figure named for what it counts; hidden walkthrough frames inert; the README and CONTRIBUTING pointing at the walkthrough and the browser job.

## v0.7.0, 28 September 2026

Wave 4 of the engineering plan: the pre-UX cleanliness unit (U16) of the consolidated backlog, one pane, landed on `staging` with CI green on its unit branch before the merge and the gate on the combined tree, reviewed as one change on a bed upgraded in place from `v0.6.0`, plus the fixes that review asked for before the tag. 89 commits; 5,041 tests.

- **Before the first UX pane (U16, step 40a; decisions Q3, N14, the UX lock).** The document language is `en-GB`; the Surfaces links and the Slack OAuth redirect land on the environment panel, on a cold load too; the chat room, the voice room and the mock environment load on demand, so the agent page's largest chunk falls from 1.25 MB to 538 KB; the types two layers shared live in `src/` and a test walks every client module's imports to keep the backend and the model layer's environment out of the browser bundle; the `/demo` recording states when it was exported, which build it was and that the run came before; the accessibility floor (WCAG 2.2 AA, checked in the gate from wave 5) is written in CONTRIBUTING.
- **The cleanliness PR (U16, step 41; the TypeScript standard).** Dead exports, a dead barrel, an uncalled probe, a module nothing imported since May and duplicate predicates and helpers are gone or single; object shapes are interfaces; every union switch closes on a `never` guard that refuses a persisted value no release wrote; every caught value is narrowed through one helper and every discarded promise says where its rejection lands, or reports it; the owner key is read explicitly at every site and the token's subject means the subject again; SECURITY.md and the README say only what the code checks, with the customer-local profile, the signed session, the Origin check and the default ports stated; about seventy copy facts corrected; em dashes replaced in code and tests except in the recorded prompts and replies the frozen evidence was made with; 396 exports documented and eleven modules given their first mirror test; a plan outside one to eight steps is refused with its reason on the card, never cut.
- **The fixtures (U16, step 41a; decisions N15, N6).** One substitution rule, run by a script and checked by a test, replaces the manager's DM id, the operator's name and branch prefixes in every recording under `tests/`; a fixtures README states that the remaining Slack, Linear and Notion identifiers are the operator's own synthetic workspaces and where each recording came from; four handbook pages are byte-identical to the tracked company bed and pinned; three committed re-grades name their source from the checkout root and the re-grade writer no longer records a machine path.
- **The engineering standard is public (decision N27).** `docs/standards/typescript.md` is tracked and CONTRIBUTING points at it.
- **From the review.** A channel named in any script is read by all three intake-scope grammars, and a Latin channel name touching Chinese prose still matches; the voice start route shows fixed text when the provider refuses a signed URL and logs the provider's body (N26); the skill approval and retry refusals reach the card in plain words; a refused re-sync, unlink, strike or restore shows why instead of leaving the rejection unhandled; the voice room, the chat room and their loading placeholder share one frame; the `'channel'` answer route no path wrote is gone from the type and the validator.

## v0.6.0, 28 September 2026

Wave 3.5 of the engineering plan: eleven units the wave 2 and 3 handovers and reviews called for, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change on a real-mode bed upgraded in place from `v0.5.0`, plus the fixes that review asked for before the tag. 324 commits; 4,932 tests.

- **The event contract, and the ledger as an auditor's record (S, decisions N10 and Q14).** Every event Day0 writes is one of a typed contract in TypeScript that the writers, the export and the feed share; the feed labels every type or the build fails; export version 3 carries the delivery records of Day0's own messages; a verdict names the charter version it was reached under and a skip writes its terminal event; the automatic split reproduces from the ledger after a manager change.
- **Retire, claims and the approved list (S, S2, decisions Q15, N1, Q5).** A retired employee's claims and rejections still bind through an owner-keyed retirements table, so a sibling never repeats or contradicts work the retired employee held; a connected surface's tool list is frozen at approval and widened only by the manager's explicit act; the attempt count parks an evaluation that keeps dying so one row never blocks the queue, and a park for a provider outage re-admits itself; who set a surface's access is recorded; two routine probes of one card make one round-trip, and a probe in flight cannot reconnect an ended access.
- **One approval, and the access length (Q, decisions Q10 and Q5).** A card is approved by the manager alone; the IT stamp is neither written nor read, and cards the manager alone had approved are approved by the upgrade; every approval starts at 90 days, the model no longer proposes an access length, and the card shows the end date with a renew control.
- **Credentials keyed by value (C, C2, decision Q15).** Every stored value is sealed under a named key and opened by it, re-sealed in pages under the owner binding by the upgrade; rotation re-seals every credential; a page credential is keyed by a fingerprint of its value, so a moved or relabelled value keeps its credential and a swapped value is a new one with the old superseded; orientation binds a page marker to its credential by label; a swapped-out row is kept thirty days and a revoked row is never pruned.
- **The browser and HTTP rungs (B).** The sign-in replay re-sends only the controls a login ends on, never a click that was the work; a failed browser write withholds the next; the ledger row names the element acted on; the probe signs in and checks the documented marker; the HTTP allowlist keeps the verb with the path and matches templated paths segment by segment, the credential is placed in a header only, and every write goes to the address the probe checked; a rate limit leaves a surface connected; a chat reader contract sits under the documented-API rung.
- **The manager channel (M, decisions Q6 and Q13).** A Slack request carries the ticket, its link and where a chat ask is answered; a reply resolves only its own request and the DM is read only while something is open; a request whose message is gone is closed with an event; a deactivated manager's return heals on the hourly re-probe; a decided request is marked decided in its own message and acknowledgements sit in its thread; an expired surface takes no intake, no apply and no message; a plan whose obligations judgement or ticket read failed waits for the manager and is drafted again when the system connects; the notice for an ending access names its day in the agent's zone.
- **The documentation store (D, S2, decisions A4, A6, N8).** A sync that fails resumes from where it stopped, restarting only if the listing changed under it; one unreadable page fails one row; every corpus read is paged and the finish runs in fenced phases; per-page listing rows lift the generation bound; a system named in Chinese characters keys by its own slug and matches its page; orientation judges a documented API by the same private-host rule as MCP; reader secrets are entered at link, never in a locator; a plaintext MCP address is never a web UI candidate.
- **The card (K, decisions N7, N11, N12, N14).** The access end date and renew control, one Approve, the approved-tools editor, the loop's waiting and parked states with their reasons, the zone at deploy and in every stamp, the manager's minutes on plan approval, automatic changes split from reads and messages, the five pilot figures, a label for every event, every control reporting in a live region, axe clean at 1440 and 390.
- **The post-wave fixes (F, F2).** The export drops name-bearing keys and the owner's identity subject and redacts labelled personal data; the release check refuses a checkout older than its migrations before anything is pushed and a stamp older than the newest migration; NOTICE is generated from the lockfile and the release, the Protean sentence stated; a Node version pinned for the runner and the laptop alike, a `pnpm gate` that runs without the agent variables, and the whole tree formatted with the check in lint; `pnpm export:trace`; the mock generator seeds all or nothing; an edit of a manager DM message is confined to the close of the one request it answers, and a tab in an operation path no longer dodges the chat rules.
- **From the review.** Beyond the replay fix: a card whose probe failed under v0.5.0 is frozen after the upgrade; a browser card is not stranded by the single-approval migration; pre-0.6.0 credential rows open after the key switch; the labelled personal-data forms the export claims are found; a probe's driver refusal and a marker the login page also shows are read for what they are; a template segment is decoded to a fixpoint; a plan ask is withdrawn on a re-draft.

## v0.5.0, 28 September 2026

The third wave of the engineering plan: units U6, U8, U9, U12 and U15 of the consolidated backlog, one pane each, landed on `staging` with CI green on every unit branch before its merge and the gate on the combined tree, reviewed as one change, plus the fixes that review asked for before the tag. 128 commits; 4,458 tests.

- **The browser rung under the ladder, and the skills tree out of git (U6, decisions Q1, Q8, N17).** A browser write resolves only to an element a person can act on, and the credential is typed only into a text box whose name is a password-kind name; a documented-API tracker that is not Slack connects through the probe, and a documented-API chat that is not Slack is refused as a stated limitation rather than read through Slack's API with the wrong key; the vendored skills tree and its lock leave tracking and `convex.json` stops the CLI reinstalling them.
- **The documentation author's first hour, and polling that survives a 429 (U8, decision Q13).** A page that first names an absent system re-runs orientation; a mid-read timeout is recorded as transient with its cause; one rate-limit reply costs one request, with exponential backoff honouring `Retry-After`; the structural floor and the model guard take a documented login pair, a quoted value and a Chinese label without storing prose; a page-grammar guide for documentation authors under `docs/running/`, including a documented API that is not Slack.
- **The manager can be replaced; what the card gets wrong; recoveries (U9, decision Q6).** The manager is changed by a mutation with a `manager.changed` event, from the dashboard or when a probe resolves a different person, and open decision requests are re-sent; every claim has a recovery (a closing phase whose authoring died, a skill proposal that never landed, a draft that died, a note whose send died mid-flight); charter approval seeds server-side; a server refusal is a refusal and the page is checked after every click; a send-once fence keeps a dropped MCP connection from sending twice.
- **The export as the pilot's evidence, and time (U12, decisions Q14, A9, N11, N12).** `metrics:recompute --expect` reproduces the recorded Supervision figures from a dated, paged, redacted trace, and CI does so from a tracked pseudonymised fixture; the export pages at 100 rows and drops personal keys, token shapes, stored values, the install claim and the manager's identity; a verdict names the charter version it was reached under and a skip writes its terminal event; each agent carries a zone, set at deploy and backfilled by the upgrade, and every server-side stamp and digest carries a date in it; the plan card's optional "this would have taken me N minutes" is stored.
- **The legal seat, the Chinese data-loss members, the hosted budget, the contributor's first week (U15, decisions N6, N18, N8, N9, A15).** No real name in the product: the demo avatars are files named by digest; one generated `NOTICE` from the dependency graph and the lifted sources, with the LGPL and MPL texts, and a test that fails the gate when it drifts; a Chinese-named runbook or surface keeps its own slug; the evaluation harness refuses to run without a bed flag; the redactor runs read-only as an unprivileged user, with a one-shot service owning its volumes; test-side conventions in CONTRIBUTING and across the suite.
- **From the review.** A password in Chinese, corner or curly quotation marks is taken whole by the floor and the guard through one shared quote table, and a quoted Latin phrase in any quote style is stored rather than refused as prose; the phrase rule refuses only a word-shaped value, so a letters-only random password followed by words is kept; a click stays outcome-unknown when the page check after it cannot run, so a Retry never re-clicks a Save; the snapshot ref is read from the driver's attributes, so a bracketed element name cannot redirect a write; four tests no longer leave temp directories.

## v0.4.0, 28 September 2026

The second wave of the engineering plan: units U3, U7, U10, U13 and U14 of the consolidated backlog, one pane each, landed on `staging` with the gate on every merge, reviewed as one change, plus the scope follow-up that review confirmed and the fixes it asked for before the tag. 136 commits; 4,166 tests.

- **Expiry, the read grant and the loop bounds (U3).** A surface's access clock starts at approval and only the manager moves it, with an expiry event and a notice a week before (decision Q5); a revoked read scope stops intake and survives a reconnect (Q7, N2); evaluation waits for a free slot before the scope call, the stall sweep, the skill walk and the cap count run inside the transaction limits, and the apply's dead-man switch counts from the claim; the gate passes under a shell that exports model addresses.
- **The migration path, backup, restore and upgrade (U7, decisions Q12 and N10).** Three new tables and a declared credential key id; the upgrade's steps run in bounded, resumable pages and stamp the release as they finish; a release check before any push reads the changelog headings as the release list and refuses a jump of more than one release; `backup`, `restore` and `upgrade` verbs in setup with a README section; the sync generation fences pages, the mirror and the credential store; ticket listings are kept by work item; `--force` keeps the credential key and rotation is its own confirmed verb; the env sync refuses to clear or replace the key over stored credentials; credentials superseded before this release are revived.
- **One deployment per workspace; the rehearsal internal (U10, decisions Q9 and N4).** A deployment takes no Slack mention written before its agent was deployed; a connected surface's tool list is frozen at connection; the rehearsal moved under the bed with its shared pieces in a scripts library, and its aliases left `package.json` with the other bed tools.
- **The customer-local profile (U13, decision A7).** A customer OIDC issuer beside the local one on a single deployment, with the owner key applied where every guard reads it; a deployment profile so real mode runs under `next start`; a private-hosts allowlist for internal MCP servers and git hosts; the security headers block; a bind variable per compose service; the unlock session carried in the token so two browsers are told apart.
- **The owner, two agents, the skill body, the mode flip and the bill (U14, decisions Q15 and N1).** Retire is a tombstone in real mode and revokes only unbound credentials; a sealed credential is bound to its owner and opens only as that owner; an owner-wide claim before the model call so two agents on one project never double-write; a skill is revisable until a plan that runs it is approved and the execution claim records the body it ran; the structured-output rung, its fallback and any demotion are recorded on every model call, and token usage is metered with the authoring and closing calls on the ledger.
- **The scope call fails closed (E-70).** An item whose scope call throws, times out or answers out of shape is parked with one unavailable event and never admitted or executed; the suite's scripted scope replies all parse.
- **From the review.** A fresh clone whose first setup run stops before the push completes on the rerun; the access-clock backfill runs as the upgrade's own migration and restarts a card the new code ended early; a renewal never widens a frozen tool list; a listed git host is resolved and checked, the clone pinned to the checked address with no redirect, proxy or LFS download; userinfo is refused in every remote locator; the profile, the customer issuer and the private hosts reach the deployment through the sync in an order the auth config accepts. A private-host list naming `localhost`, a loopback or link-local literal, or a numeric suffix is now refused whole, and with it every MCP client and git source until it is corrected; `check:setup` and `.env.example` say so.

## v0.3.0, 27 September 2026

Four units the first wave's handovers and review called for, one pane each, landed on `staging` with the gate on every merge, reviewed as one change, plus the fixes that review asked for before the tag. 80 commits; 3,866 tests.

- **The charter reaches the closing phase, and questions are declared (U18).** The executor's closing prompt carries the charter and a clause-bound decision records its clause; an action rejection holds a sibling's plan for the manager as a plan rejection does (`rejectedAt`); a question for the manager is a field the model declares in its output, with one model judgement for older output, and the word list is gone from the hold path (decision N20).
- **The ticket is re-read before the first write (U19).** An apply whose ticket changed hands, state or label since the plan is withheld with a named reason; a re-listed ticket's row follows the tracker and a withdrawn ticket withdraws its waiting row; two status changes on one ticket keep the last and a reused write says which run sent it; a Linear server whose fields cannot be read holds the checkpoint; the two remaining MCP clients connect only through the checked address; a rotated credential value no longer lifts a person's revoke.
- **Exa leaves the product (U20, decision N19).** No search key, no client, no web research step after charter approval; provider-native research is a roadmap line.
- **The repository reads as a product (U21, decision N21).** The controlled comparison harness is named for what it measures; the README and the evaluation page carry the numbers, the method, the caveat and how to reproduce; the frozen evidence keeps its recorded file names.
- **From the review.** A refused listing is never the re-read's baseline and a claimed row is withdrawn on a refusal; a record naming another ticket or none of the compared fields withholds; a Retry excuses an open state only, never a do-not-automate label or a close; a Retry note answers a declared question only when the stop was a question stop; the declared-question mapping has a test per phase.

## v0.2.0, 27 September 2026

The first release cut from `staging` under the engineering plan (`docs/plans/engineering-plan-2026-09-27.md`): units U1, U2, U4, U5 and U11 of the consolidated backlog, one pane each, landed with the four-command gate on every merge, reviewed as one change, plus two fixes from that review. 101 commits; 3,761 tests in 267 files.

- **First-run defects (U1).** Shift+C is left to a focused field; a plan rejected on one employee holds a sibling's plan for the manager and never reaches autonomy; cut or content-filtered model replies are refused, moderation and errors are read inside a 200, and a plan draft the model refuses fails instead of re-running every lease; the Day-1 1:1 gains a Finish control and a composer bound.
- **The held question and the credential (U2).** With no chat surface, a question in the executor's notes withholds the writes that wait on it and renders as a hold; a superseded credential whose value returns is reactivated; a documentation source over 500 pages is paged, not refused, and its cursor resumes.
- **The key, the session and the origin (U4).** Setup adopts an existing credential key before minting one; the unlock cookie is a signed per-browser session instead of the secret; every credentialed browser action checks the page it is on; the MCP client connects to the address that was checked; the two POST routes refuse a cross-origin request.
- **Tickets, the README path and a second machine (U5).** A ticket assigned to a person is skipped and Retry never re-sends a status change; the README's setup path runs on a clean machine; setup reports an unreachable daemon or model endpoint instead of failing later.
- **The evaluation figures (U11).** No grader reads text the harness wrote; the frozen results carry their task definitions; the gate matrix carries a commit; the published comparison carries a caveat naming the five ways the task set favoured one arm (decision N16); superseded result directories moved to the private archive.
- **From the review.** A cut good-habits reply no longer aborts the steps after charter approval; the MCP and browser rungs refuse any placeholder other than the credential's before sending.

## v0.1.0, 16 to 19 September 2026

The tag `v0.1.0` marks this release at `7f59973`. The recorded demo run ran on `f739614`, the last commit dated 19 September, and the hosted halves were brought to it on 20 September 2026: the cloud Convex functions first (293 functions, three new empty tables, no row of the protected office changed), then the app at `day0-olive.vercel.app`. 415 commits dated 17 to 19 September; 3,517 tests in 252 files.

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
- `c570265`, `181ba4a`, `275f799`, `766d77b` feat(setup-page, landing): the three ways to run it by the README's names, real mode's first success; Try the demo goes through sign-in to the hosted mock office and the recording gets its own button
- `561e6b5`, `4fc50f7`, `030c6fa`, `454a611`, `c8ca560`, `5d1a2ff`, `7c44291`, `2c5b528`, `d63da6f` docs(readme): the three ways to run it with real mode as the local route, each run section opening with its one command; the disclosures, the evidence map and the interface pointer; the recorded run and demo video are the 17 September recording, both halves
- `0f0d8a1`, `38c0bd2`, `d9254c5`, `27d80ad` docs: this changelog, the security policy, the reuse interfaces page, the contribution guide with issue forms and a pull request template
- `bb18035` chore(evaluation): remove the 14B local bed and every mention of it

## Before v0.1.0, 4 to 16 September 2026

The release pointer stood at `5fac642` on 16 September 2026 and `day0-olive.vercel.app` was deployed from it; both moved on with the entry above. 440 commits dated 4 to 16 September.

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

## Before v0.1.0, 2 to 3 September 2026

The evaluation freeze: snapshot `cc4e7a5`, 3 September 2026 (no tag). The recorded real-mode run and the README's documented run are both on `a41fd94`, 3 September. 89 commits dated 2 to 3 September.

### 3 September 2026

- `cc4e7a5` docs: publish the data-source and compliance statement (no longer tracked since 27 September 2026; the README's Disclosures state the data sources, and `SECURITY.md` the credential, redaction and deletion handling)
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

## Before v0.1.0, 25 August to 1 September 2026

No tag. 407 commits dated 25 August to 1 September. The real-mode surface layer, the exact-action gate, credentials and redaction, the evaluation harness and the first frozen beds.

### 30 August to 1 September 2026: the evaluation harness

- `29d2900` feat(evaluation): add fixed tasks and programmatic graders
- `d59a92c` feat(evaluation): add ordinary-agent control arm
- `5431e18`, `fdbafe5`, `de3f5d1`, `3728c1a`, `1dcf75d` feat(evaluation): gate day0 mock writes; expose task seeding and grader snapshots; share non-zero model temperature; the evidence report contract; timestamp the first correct task effect
- `30d4404`, `8dc77cc`, `48e630d` feat(evaluation): the resumable comparison driver; record the backend's model and write each run to its own directory; regrade retained evidence without models
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

## Before v0.1.0, 12 to 13 August 2026

No tag. 122 commits dated 12 to 13 August. Standing as an open-source project: the account-free route and the local sandbox.

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

## Before v0.1.0, 9 May 2026

No tag; last commit of the day `2d4b82c`. 42 commits dated 9 May: the first build.

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
