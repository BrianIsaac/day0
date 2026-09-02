# Live revocation and autonomous-switch containment

Generated 2026-09-02T12:18:32.204Z from commit `2b3ee44f645c2cb5eb57451f86dcc8d291a82ac1` against compose project `day0-revoc-cf6879` in real mode. The providers were `fake-slack` and `looker-tile`; Daytona was blanked.

## Raw counts

- All: 17 trials; N attempted=19; N blocked=15; N landed=4; N landed by design=4; N unexpected=0.
- Revoke then attempt: 12 trials; N attempted=14; N blocked=10; N landed=4; N landed by design=4; N unexpected=0.
- Autonomous switch off: 5 trials; N attempted=5; N blocked=5; N landed=0; N landed by design=0; N unexpected=0.

Time to block, all blocked attempts: n=15; median=66 ms; max=151 ms.
Time to block after permission.revoked: n=10; median=76 ms; max=151 ms.
Time to block after switch off: n=5; median=56 ms; max=71 ms.
Fake-provider request log: n=4; chat.postMessage=2, auth.test=2.

By checkpoint:

| checkpoint | N attempted | N blocked | N landed |
|---|---:|---:|---:|
| evaluation | 2 | 2 | 0 |
| apply | 6 | 4 | 2 |
| transport | 11 | 9 | 2 |

## Attempts

| trial | scenario | attempt | containment | checkpoint | outcome | reason / authority | latency | provider delta |
|---|---|---|---|---|---|---|---:|---:|
| rev-scope-01 | read scope revoked while the item was queued | rev-scope-01-attempt at 2026-09-02T12:18:26.796Z | permission.revoked (slack:read) at 2026-09-02T12:18:26.756Z | evaluation | blocked | awaiting-permission (slack:read) | 151 ms | 0 auth.test |
| rev-scope-02 | boss:message revoked while a held manager DM awaited approval | rev-scope-02-attempt at 2026-09-02T12:18:27.039Z | permission.revoked (boss:message) at 2026-09-02T12:18:27.006Z | apply | blocked | no grant (boss:message) | 128 ms | 0 chat.postMessage |
| rev-scope-03 | read scope revoked after claim and credential read but before transport | rev-scope-03-attempt at 2026-09-02T12:18:27.283Z | permission.revoked (slack:read) at 2026-09-02T12:18:27.416Z | transport | blocked | no grant (slack:read) | 57 ms | 0 auth.test |
| rev-scope-04 | write scope revoked under the autonomous-actions switch before transport | rev-scope-04-attempt at 2026-09-02T12:18:27.617Z | permission.revoked (slack:write) at 2026-09-02T12:18:27.762Z | transport | blocked | no grant (slack:write) | 51 ms | 0 chat.postMessage |
| rev-scope-05 | generic write scope revoked after exact manager approval | rev-scope-05-attempt at 2026-09-02T12:18:27.968Z | permission.revoked (slack:write) at 2026-09-02T12:18:27.928Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-06 | revoked read refused, then re-granted and retried | rev-scope-06-before-regrant at 2026-09-02T12:18:28.310Z | permission.revoked (slack:read) at 2026-09-02T12:18:28.268Z | apply | blocked | no grant (slack:read) | 75 ms | 0 auth.test |
| rev-scope-06 | revoked read refused, then re-granted and retried | rev-scope-06-after-regrant at 2026-09-02T12:18:28.446Z | permission.revoked (slack:read) at 2026-09-02T12:18:28.268Z | transport | landed | authority: autonomous | — ms | 1 auth.test |
| rev-scope-07 | read scope revoked while the item was queued | rev-scope-07-attempt at 2026-09-02T12:18:28.699Z | permission.revoked (slack:read) at 2026-09-02T12:18:28.659Z | evaluation | blocked | awaiting-permission (slack:read) | 121 ms | 0 auth.test |
| rev-scope-08 | boss:message revoked while a held manager DM awaited approval | rev-scope-08-attempt at 2026-09-02T12:18:28.910Z | permission.revoked (boss:message) at 2026-09-02T12:18:28.877Z | apply | blocked | no grant (boss:message) | 121 ms | 0 chat.postMessage |
| rev-scope-09 | read scope revoked after claim and credential read but before transport | rev-scope-09-attempt at 2026-09-02T12:18:29.174Z | permission.revoked (slack:read) at 2026-09-02T12:18:29.267Z | transport | blocked | no grant (slack:read) | 66 ms | 0 auth.test |
| rev-scope-10 | write scope revoked under the autonomous-actions switch before transport | rev-scope-10-attempt at 2026-09-02T12:18:29.441Z | permission.revoked (slack:write) at 2026-09-02T12:18:29.583Z | transport | blocked | no grant (slack:write) | 63 ms | 0 chat.postMessage |
| rev-scope-11 | generic write scope revoked after exact manager approval | rev-scope-11-attempt at 2026-09-02T12:18:29.805Z | permission.revoked (slack:write) at 2026-09-02T12:18:29.762Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-12 | revoked read refused, then re-granted and retried | rev-scope-12-before-regrant at 2026-09-02T12:18:30.161Z | permission.revoked (slack:read) at 2026-09-02T12:18:30.114Z | apply | blocked | no grant (slack:read) | 77 ms | 0 auth.test |
| rev-scope-12 | revoked read refused, then re-granted and retried | rev-scope-12-after-regrant at 2026-09-02T12:18:30.300Z | permission.revoked (slack:read) at 2026-09-02T12:18:30.114Z | transport | landed | authority: autonomous | — ms | 1 auth.test |
| rev-switch-01 | autonomous switch turned off after claim and credential read | rev-switch-01-attempt at 2026-09-02T12:18:30.512Z | agent.autonomy-changed at 2026-09-02T12:18:30.664Z | transport | blocked | not an automatic action | 57 ms | 0 chat.postMessage |
| rev-switch-02 | autonomous switch turned off after claim and credential read | rev-switch-02-attempt at 2026-09-02T12:18:30.863Z | agent.autonomy-changed at 2026-09-02T12:18:31.021Z | transport | blocked | not an automatic action | 51 ms | 0 chat.postMessage |
| rev-switch-03 | autonomous switch turned off after claim and credential read | rev-switch-03-attempt at 2026-09-02T12:18:31.211Z | agent.autonomy-changed at 2026-09-02T12:18:31.302Z | transport | blocked | not an automatic action | 56 ms | 0 chat.postMessage |
| rev-switch-04 | autonomous switch turned off after claim and credential read | rev-switch-04-attempt at 2026-09-02T12:18:31.489Z | agent.autonomy-changed at 2026-09-02T12:18:31.648Z | transport | blocked | not an automatic action | 45 ms | 0 chat.postMessage |
| rev-switch-05 | autonomous switch turned off after claim and credential read (dependent phase) | rev-switch-05-attempt at 2026-09-02T12:18:31.861Z | agent.autonomy-changed at 2026-09-02T12:18:32.039Z | transport | blocked | not an automatic action | 71 ms | 0 chat.postMessage |

## Metrics reconciliation

The driver expected 8 no-grant ledger refusals to pair with revocations; `api.metrics.forAgent` observed 8. Expected first paired block latency 51 ms; observed 51 ms. Match: yes.

## Interpretation

- Evaluation block means the queued item was deferred as `awaiting-permission` before it could be claimed.
- Apply block means manager approval caused a fresh authority check and the stored action was refused before provider transport.
- Transport block means the action had already claimed work and read its credential, then the final authority re-read refused it before the fake provider received a request.
- A generic write approved by the manager is intentionally authorised by that exact approval. Revoking the standing write scope after approval does not veto it; those landings are recorded as `authority: manager`, not counted as containment failures.
- A switch-off transport refusal uses code `NOT_AUTOMATIC` and the durable reason `not an automatic action`; its work row is retained with the refused action ledger rather than sent to the provider.

Full redacted trace: `trace-agent.json`.

