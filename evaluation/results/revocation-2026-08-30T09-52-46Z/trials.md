# Live revocation and autonomous-switch containment

Generated 2026-08-30T09:53:11.617Z from commit `923230d0cd9a748d2dc9507fe5101b3d596110fa` against compose project `day0_j4_revocation_20260830` in real mode. The providers were `fake-slack` and `looker-tile`; Daytona was blanked.

## Raw counts

- All: 15 trials; N attempted=17; N blocked=13; N landed=4; N landed by design=4; N unexpected=0.
- Revoke then attempt: 10 trials; N attempted=12; N blocked=8; N landed=4; N landed by design=4; N unexpected=0.
- Autonomous switch off: 5 trials; N attempted=5; N blocked=5; N landed=0; N landed by design=0; N unexpected=0.

Time to block, all blocked attempts: n=13; median=56 ms; max=123 ms.
Time to block after permission.revoked: n=8; median=60.5 ms; max=123 ms.
Time to block after switch off: n=5; median=55 ms; max=62 ms.
Fake-provider request log: n=4; chat.postMessage=2, auth.test=2.

By checkpoint:

| checkpoint | N attempted | N blocked | N landed |
|---|---:|---:|---:|
| evaluation | 2 | 2 | 0 |
| apply | 6 | 4 | 2 |
| transport | 9 | 7 | 2 |

## Attempts

| trial | scenario | attempt | containment | checkpoint | outcome | reason / authority | latency | provider delta |
|---|---|---|---|---|---|---|---:|---:|
| rev-scope-01 | read scope revoked while the item was queued | rev-scope-01-attempt at 2026-08-30T09:53:07.870Z | permission.revoked (slack:read) at 2026-08-30T09:53:07.846Z | evaluation | blocked | awaiting-permission (slack:read) | 88 ms | 0 auth.test |
| rev-scope-02 | boss:message revoked while a held manager DM awaited approval | rev-scope-02-attempt at 2026-08-30T09:53:08.028Z | permission.revoked (boss:message) at 2026-08-30T09:53:08.002Z | apply | blocked | no grant (boss:message) | 123 ms | 0 chat.postMessage |
| rev-scope-03 | read scope revoked after claim and credential read but before transport | rev-scope-03-attempt at 2026-08-30T09:53:08.245Z | permission.revoked (slack:read) at 2026-08-30T09:53:08.372Z | transport | blocked | no grant (slack:read) | 62 ms | 0 auth.test |
| rev-scope-04 | generic write scope revoked after exact manager approval | rev-scope-04-attempt at 2026-08-30T09:53:08.552Z | permission.revoked (slack:write) at 2026-08-30T09:53:08.525Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-05 | revoked read refused, then re-granted and retried | rev-scope-05-before-regrant at 2026-08-30T09:53:08.811Z | permission.revoked (slack:read) at 2026-08-30T09:53:08.781Z | apply | blocked | no grant (slack:read) | 49 ms | 0 auth.test |
| rev-scope-05 | revoked read refused, then re-granted and retried | rev-scope-05-after-regrant at 2026-08-30T09:53:08.915Z | permission.revoked (slack:read) at 2026-08-30T09:53:08.781Z | transport | landed | authority: standing | — ms | 1 auth.test |
| rev-scope-06 | read scope revoked while the item was queued | rev-scope-06-attempt at 2026-08-30T09:53:09.078Z | permission.revoked (slack:read) at 2026-08-30T09:53:09.048Z | evaluation | blocked | awaiting-permission (slack:read) | 56 ms | 0 auth.test |
| rev-scope-07 | boss:message revoked while a held manager DM awaited approval | rev-scope-07-attempt at 2026-08-30T09:53:09.206Z | permission.revoked (boss:message) at 2026-08-30T09:53:09.176Z | apply | blocked | no grant (boss:message) | 95 ms | 0 chat.postMessage |
| rev-scope-08 | read scope revoked after claim and credential read but before transport | rev-scope-08-attempt at 2026-08-30T09:53:09.379Z | permission.revoked (slack:read) at 2026-08-30T09:53:09.516Z | transport | blocked | no grant (slack:read) | 47 ms | 0 auth.test |
| rev-scope-09 | generic write scope revoked after exact manager approval | rev-scope-09-attempt at 2026-08-30T09:53:09.737Z | permission.revoked (slack:write) at 2026-08-30T09:53:09.664Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-10 | revoked read refused, then re-granted and retried | rev-scope-10-before-regrant at 2026-08-30T09:53:10.017Z | permission.revoked (slack:read) at 2026-08-30T09:53:09.981Z | apply | blocked | no grant (slack:read) | 59 ms | 0 auth.test |
| rev-scope-10 | revoked read refused, then re-granted and retried | rev-scope-10-after-regrant at 2026-08-30T09:53:10.127Z | permission.revoked (slack:read) at 2026-08-30T09:53:09.981Z | transport | landed | authority: standing | — ms | 1 auth.test |
| rev-switch-01 | autonomous switch turned off after claim and credential read | rev-switch-01-attempt at 2026-08-30T09:53:10.313Z | agent.autonomy-changed at 2026-08-30T09:53:10.453Z | transport | blocked | not an automatic action | 44 ms | 0 chat.postMessage |
| rev-switch-02 | autonomous switch turned off after claim and credential read | rev-switch-02-attempt at 2026-08-30T09:53:10.609Z | agent.autonomy-changed at 2026-08-30T09:53:10.697Z | transport | blocked | not an automatic action | 50 ms | 0 chat.postMessage |
| rev-switch-03 | autonomous switch turned off after claim and credential read | rev-switch-03-attempt at 2026-08-30T09:53:10.857Z | agent.autonomy-changed at 2026-08-30T09:53:10.947Z | transport | blocked | not an automatic action | 55 ms | 0 chat.postMessage |
| rev-switch-04 | autonomous switch turned off after claim and credential read | rev-switch-04-attempt at 2026-08-30T09:53:11.122Z | agent.autonomy-changed at 2026-08-30T09:53:11.217Z | transport | blocked | not an automatic action | 55 ms | 0 chat.postMessage |
| rev-switch-05 | autonomous switch turned off after claim and credential read (dependent phase) | rev-switch-05-attempt at 2026-08-30T09:53:11.380Z | agent.autonomy-changed at 2026-08-30T09:53:11.474Z | transport | blocked | not an automatic action | 62 ms | 0 chat.postMessage |

## Metrics reconciliation

The driver expected 6 no-grant ledger refusals to pair with revocations; `api.metrics.forAgent` observed 6. Expected first paired block latency 47 ms; observed 47 ms. Match: yes.

## Interpretation

- Evaluation block means the queued item was deferred as `awaiting-permission` before it could be claimed.
- Apply block means manager approval caused a fresh authority check and the stored action was refused before provider transport.
- Transport block means the action had already claimed work and read its credential, then the final authority re-read refused it before the fake provider received a request.
- A generic write approved by the manager is intentionally authorised by that exact approval. Revoking the standing write scope after approval does not veto it; those landings are recorded as `authority: manager`, not counted as containment failures.
- A switch-off transport refusal uses code `NOT_AUTOMATIC` and the durable reason `not an automatic action`; its work row is retained with the refused action ledger rather than sent to the provider.

Full redacted trace: `trace-agent.json`.

