# Security

Day0 is a working demonstration, not a production service, and it has had no security audit. This file says what the code does about keys and data, where the boundaries are, and how to report something that crosses one. The README describes the same mechanisms in the course of explaining how to run the product; this is the short version, in one place.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), which reaches the maintainer without a public record. If that route is unavailable to you, open an issue that says only that you have a private security report and how to reach you, and the maintainer will make contact.

Include the commit you tested, the route you ran (the README's account-free, OpenAI-key, Clerk or real-mode route), what you did and what you observed. Do not include credential values, `.env.local` contents or your provider tokens; the ledger export and `pnpm check:setup` output are already free of them and are safe to attach.

There is no bounty. You can expect an acknowledgement within a week and a fix or a stated decision within a month for anything that affects the boundaries below.

## Supported versions

The tag the finals submission names, `goai-final`, and the tip of `main`. Earlier commits are history and receive no fixes.

## Key and data boundaries

What the code checks, in the order a reader meets them. Each is tested under `tests/` against the module named.

**Who may call what.** Every public Convex function that touches an agent checks that the caller owns it (`convex/ownership.ts`). Local no-auth mode replaces Clerk with one fixed synthetic user and a locally signed token: the private signing key stays in `.env.local` and only the public verification key is pushed to the backend (`convex/devAuth.ts`, `src/lib/dev-auth-server.ts`). The unlock secret travels once in the URL `pnpm dev` prints and then lives in an httpOnly cookie; any request whose host is not loopback is refused. `NEXT_PUBLIC_DEV_NO_AUTH=true` is refused outside `next dev` and fails a production build.

**Real mode cannot be hosted.** `DAY0_SURFACE_MODE=real` throws unless the process is local no-auth development and nothing names Vercel (`src/lib/surface-mode.ts`). The hosted demo is mock mode by construction and cannot reach a live system.

**Credentials.** A credential enters through a write-only field on a connection card or documentation source and is sent only to a server action; the input is cleared on submit and the value is never held in React state. It is stored with AES-256-GCM under `DAY0_CREDENTIAL_KEY`, a server-side secret written by `pnpm dev:no-auth-key` and pushed to the deployment; no public query returns ciphertext or IV (`src/lib/credential-crypto.ts`, `convex/credentials.ts`). A credential found in linked documentation is encrypted into the same table and the page is stored with a marker in its place; removing the value from the page on a later sync revokes it. Plaintext exists on the server only inside the action that decrypts it for an authorised transport.

**Redaction before persistence.** Documentation sync redacts detected credentials before a page is stored, using the exact values the owner already holds, a structural layer, and the span model in the `redactor` component; real mode refuses to store a page without the component. Provider outcomes, identifiers and errors are redacted before they are written to the ledger, including literal, JSON-escaped and URL-encoded echoes of a credential, and a run that had no span model available is marked `structural-only` (`convex/docSyncActions.ts`, `src/surfaces/redact.ts`, `src/redaction/`). Detection can miss a secret; the dashboard labels limited redaction rather than hiding it.

**Grants, revocation and the gate.** Every effect is a literal action held by the exact-action gate before it reaches an adapter (`src/surfaces/policy.ts`). It needs a scoped grant, `<surface>:read` or `<surface>:write`, and grants are revocable from the dashboard. Authority is re-read at evaluation, at apply and immediately before transport, so a scope revoked while a run is executing refuses the write in flight and records the refusal. A write the manager approved as a literal payload keeps that approval as its own authority after the standing scope is revoked, and the ledger records `authority: manager`; a write authorised only by the autonomy switch is refused the moment its scope is revoked. Turning the switch on asks for confirmation.

**Deletion.** `reset:deleteMyData` deletes the caller's agents and their rows in the 20 enumerated related tables, a list a test checks against the schema (`convex/reset.ts`). A plain reset keeps the owner's documentation sources and stored credentials. A reset with documentation unlink, or an unlink on its own, deletes the ciphertext and IV of every credential that source or owner held, at once and with no grace period, and keeps the value-free row as the audit trail. Day0 cannot delete an effect that already landed on an external system.

**The verification sandbox.** A skill the agent authored becomes callable only after its smoke test has run in the bundled local sandbox or in Daytona. The local sandbox has no network interface, a read-only root, a per-run tmpfs, dropped capabilities, `no-new-privileges`, an unprivileged user after start-up, a 60-second wall clock and process, memory and file limits, and it reaps escaped processes (`docker-compose.yml`, `sandbox/skill_sandbox.py`). It is verification isolation for code a model wrote to check its own work. It is not protection against hostile code, and the Docker socket is never mounted into the backend.

**The ElevenLabs webhook.** The post-call webhook verifies the timestamp and the HMAC over the raw body before it parses anything, answers 503 when no secret is configured rather than failing open, and finalises a transcript only when the session token matches the agent and the conversation (`app/api/voice/elevenlabs/webhook/route.ts`, `convex/voice.ts`).

**Exports and evidence.** The ledger export removes owner addresses, token shapes and every credential value the owner stored before it leaves the backend. The frozen evaluation evidence under `evaluation/results/` retains field names and SHA-256 digests of action payloads, not model-produced values.

## What is out of scope

- The self-hosted Convex backend has no authentication of its own beyond the token the app presents. `CONVEX_BIND_ADDR` defaults to loopback; widening it publishes a database to your network, and the README says so where it explains the setting.
- Provider-side processing and retention (OpenAI, Featherless, Notion, Linear, Slack, ElevenLabs, Exa, Daytona) follow your account terms with those providers and were not audited by this project.
- A container escape from the local sandbox, or a compromised Docker host, is outside what the sandbox claims to hold.
- Day0 is not a secret manager, and shared credentials found in documentation should be rotated into one; the card that finds one says so.

## Disclosure

Fixes for reported issues are noted in `CHANGELOG.md` with the affected boundary named and without the reporter's details unless they ask to be credited.
