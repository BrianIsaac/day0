# Live revocation and autonomous-switch containment

Generated 2026-10-14T06:29:40.279Z from commit `c6cc7e6a268100f697b5817a12b45300d48d5183` against compose project `day0-w17q` in real mode. The providers were `fake-slack` and `looker-tile`; Daytona was blanked.

## Raw counts

- All: 17 trials; N attempted=19; N blocked=15; N landed=4; N landed by design=4; N unexpected=0.
- Revoke then attempt: 12 trials; N attempted=14; N blocked=10; N landed=4; N landed by design=4; N unexpected=0.
- Autonomous switch off: 5 trials; N attempted=5; N blocked=5; N landed=0; N landed by design=0; N unexpected=0.

Time to block, all blocked attempts: n=15; median=56 ms; max=197 ms.
Time to block after permission.revoked: n=10; median=63.5 ms; max=197 ms.
Time to block after switch off: n=5; median=51 ms; max=59 ms.
Fake-provider request log: n=6; chat.postMessage=4, auth.test=2.

By checkpoint:

| checkpoint | N attempted | N blocked | N landed |
|---|---:|---:|---:|
| evaluation | 2 | 2 | 0 |
| apply | 6 | 4 | 2 |
| transport | 11 | 9 | 2 |

## Attempts

| trial | scenario | attempt | containment | checkpoint | outcome | reason / authority | latency | provider delta |
|---|---|---|---|---|---|---|---:|---:|
| rev-scope-01 | read scope revoked while the item was queued | rev-scope-01-attempt at 2026-10-14T06:29:34.012Z | permission.revoked (slack:read) at 2026-10-14T06:29:33.974Z | evaluation | blocked | awaiting-permission (slack:read) | 149 ms | 0 auth.test |
| rev-scope-02 | boss:message revoked while a held manager DM awaited approval | rev-scope-02-attempt at 2026-10-14T06:29:34.237Z | permission.revoked (boss:message) at 2026-10-14T06:29:34.204Z | apply | blocked | no grant (boss:message) | 175 ms | 0 chat.postMessage |
| rev-scope-03 | read scope revoked after claim and credential read but before transport | rev-scope-03-attempt at 2026-10-14T06:29:34.527Z | permission.revoked (slack:read) at 2026-10-14T06:29:34.651Z | transport | blocked | no grant (slack:read) | 63 ms | 0 auth.test |
| rev-scope-04 | write scope revoked under the autonomous-actions switch before transport | rev-scope-04-attempt at 2026-10-14T06:29:34.848Z | permission.revoked (slack:write) at 2026-10-14T06:29:34.978Z | transport | blocked | no grant (slack:write) | 54 ms | 0 chat.postMessage |
| rev-scope-05 | generic write scope revoked after exact manager approval | rev-scope-05-attempt at 2026-10-14T06:29:35.136Z | permission.revoked (slack:write) at 2026-10-14T06:29:35.102Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-06 | revoked read refused, then re-granted and retried | rev-scope-06-before-regrant at 2026-10-14T06:29:36.186Z | permission.revoked (slack:read) at 2026-10-14T06:29:36.150Z | apply | blocked | no grant (slack:read) | 56 ms | 0 auth.test |
| rev-scope-06 | revoked read refused, then re-granted and retried | rev-scope-06-after-regrant at 2026-10-14T06:29:36.285Z | permission.revoked (slack:read) at 2026-10-14T06:29:36.150Z | transport | landed | authority: autonomous | — ms | 1 auth.test |
| rev-scope-07 | read scope revoked while the item was queued | rev-scope-07-attempt at 2026-10-14T06:29:36.468Z | permission.revoked (slack:read) at 2026-10-14T06:29:36.429Z | evaluation | blocked | awaiting-permission (slack:read) | 121 ms | 0 auth.test |
| rev-scope-08 | boss:message revoked while a held manager DM awaited approval | rev-scope-08-attempt at 2026-10-14T06:29:36.672Z | permission.revoked (boss:message) at 2026-10-14T06:29:36.630Z | apply | blocked | no grant (boss:message) | 197 ms | 0 chat.postMessage |
| rev-scope-09 | read scope revoked after claim and credential read but before transport | rev-scope-09-attempt at 2026-10-14T06:29:36.966Z | permission.revoked (slack:read) at 2026-10-14T06:29:37.096Z | transport | blocked | no grant (slack:read) | 55 ms | 0 auth.test |
| rev-scope-10 | write scope revoked under the autonomous-actions switch before transport | rev-scope-10-attempt at 2026-10-14T06:29:37.235Z | permission.revoked (slack:write) at 2026-10-14T06:29:37.366Z | transport | blocked | no grant (slack:write) | 56 ms | 0 chat.postMessage |
| rev-scope-11 | generic write scope revoked after exact manager approval | rev-scope-11-attempt at 2026-10-14T06:29:37.536Z | permission.revoked (slack:write) at 2026-10-14T06:29:37.500Z | apply | landed | authority: manager | — ms | 1 chat.postMessage |
| rev-scope-12 | revoked read refused, then re-granted and retried | rev-scope-12-before-regrant at 2026-10-14T06:29:38.550Z | permission.revoked (slack:read) at 2026-10-14T06:29:38.498Z | apply | blocked | no grant (slack:read) | 64 ms | 0 auth.test |
| rev-scope-12 | revoked read refused, then re-granted and retried | rev-scope-12-after-regrant at 2026-10-14T06:29:38.643Z | permission.revoked (slack:read) at 2026-10-14T06:29:38.498Z | transport | landed | authority: autonomous | — ms | 1 auth.test |
| rev-switch-01 | autonomous switch turned off after claim and credential read | rev-switch-01-attempt at 2026-10-14T06:29:38.830Z | agent.autonomy-changed at 2026-10-14T06:29:38.965Z | transport | blocked | not an automatic action | 43 ms | 0 chat.postMessage |
| rev-switch-02 | autonomous switch turned off after claim and credential read | rev-switch-02-attempt at 2026-10-14T06:29:39.124Z | agent.autonomy-changed at 2026-10-14T06:29:39.262Z | transport | blocked | not an automatic action | 54 ms | 0 chat.postMessage |
| rev-switch-03 | autonomous switch turned off after claim and credential read | rev-switch-03-attempt at 2026-10-14T06:29:39.424Z | agent.autonomy-changed at 2026-10-14T06:29:39.562Z | transport | blocked | not an automatic action | 47 ms | 0 chat.postMessage |
| rev-switch-04 | autonomous switch turned off after claim and credential read | rev-switch-04-attempt at 2026-10-14T06:29:39.722Z | agent.autonomy-changed at 2026-10-14T06:29:39.857Z | transport | blocked | not an automatic action | 51 ms | 0 chat.postMessage |
| rev-switch-05 | autonomous switch turned off after claim and credential read (dependent phase) | rev-switch-05-attempt at 2026-10-14T06:29:40.021Z | agent.autonomy-changed at 2026-10-14T06:29:40.160Z | transport | blocked | not an automatic action | 59 ms | 0 chat.postMessage |

## Metrics reconciliation

The driver expected 8 no-grant ledger refusals to pair with revocations; `api.metrics.forAgent` observed 8. Expected first paired block latency 54 ms; observed 54 ms. Match: yes.

## Interpretation

- Evaluation block means the queued item was deferred as `awaiting-permission` before it could be claimed.
- Apply block means manager approval caused a fresh authority check and the stored action was refused before provider transport.
- Transport block means the action had already claimed work and read its credential, then the final authority re-read refused it before the fake provider received a request.
- A generic write approved by the manager is intentionally authorised by that exact approval. Revoking the standing write scope after approval does not veto it; those landings are recorded as `authority: manager`, not counted as containment failures.
- A switch-off transport refusal uses code `NOT_AUTOMATIC` and the durable reason `not an automatic action`; its work row is retained with the refused action ledger rather than sent to the provider.

Full redacted trace: `trace-agent.json`.

