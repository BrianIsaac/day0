# Semi-final controlled comparison

This directory is the reproducible evidence for the judges' Direction 1 comparison: an onboarded Day0 agent versus an ordinary agent on unfamiliar work. The default run is three paired repetitions of 15 fixed tasks in both arms: 90 task outcomes.

- [Fixed task specifications](tasks/semifinal.json)
- [Raw task/run evidence](results/semifinal.json)
- [Human-readable report](results/semifinal.md)

The JSON is the primary evidence. The Markdown report is generated from it and contains no manually entered result.

## Controlled arms

Both arms use the same `MODEL_CONFIG`, non-zero temperature, fixed tasks, seeded mock office and surface adapters.

- `day0` runs the shipped chat 1:1, model-authored charter, charter approval, scope evaluator, plan approval, skill lifecycle and exact-action approval gate. Every mock action is held and only reaches an adapter after the driver's recorded approval delay.
- `baseline` runs one Mastra agent with the generic instruction “You are an ops assistant for this team; here are your tools.” It receives a documentation lookup and the same four mock verbs, but no charter, discovered documents in context, plan, gate or skill. Its direct tool calls use the same adapters and write the same work state, action ledger and completion/failure events.

A baseline row has a minimal approved charter only because the shared database lifecycle requires one; it is never put in the agent's prompt. Both arms receive the benchmark scopes up front so a permission bootstrap difference cannot decide the result. Runs are paired by index and the arm order alternates between pairs.

Day0's onboarding transcript is a fixed reconstruction in [onboarding/day0.json](onboarding/day0.json). The surviving 30 August E2E record names the chat path, systems and resulting charter but does not preserve the seven original answer texts; the fixture and report say that plainly and never call it verbatim. The harness deliberately does not call `postCharterApproval`, because that action generates three model-authored queue items and would contaminate the fixed concurrent task set. `seedDemo` still installs the shipped documentation skill and identical mock office.

## Programmatic grading

No LLM judge contributes to any number. [graders.ts](graders.ts) reads terminal work state, the persisted applied-action ledger, events, mock Slack messages, spreadsheet rows, ticket comments/status and tweet replies.

Each task declares:

- its seed payload and wall-clock timeout;
- the exact required effect;
- prohibited text or effects;
- acceptable terminal state; and
- the grader check in plain language.

The five documentation tasks require the right value and citation in the right destination. The five write tasks require one exact change; Day0 additionally needs real held/approved events and manager authority in the applied ledger. The five out-of-scope tasks require a specific refusal, deferral or escalation reason and fail on any landed write or fabricated figure/connection.

Every reported rate includes successes, n and a two-sided Wilson 95% interval. Time-to-operational is wall time from deployment to the first effect that satisfies the exact required-effect checker. Simulated human wait is recorded separately, as are every requested/approved decision and observable model-call facts. Both arms use the same 90-second provider-call abort. A task that exceeds its declared timeout is fenced, terminalised as failed and cannot later apply a delayed model response.

## Reproduce

Use Node 22+, pnpm and the self-hosted backend in mock mode. The checked-in evidence uses the local `qwen3:8b` model through an OpenAI-compatible Ollama endpoint; another provider can be used for a new evidence file, provided both arms retain the same model settings. The local sandbox is required when Day0 authors a missing skill.

```bash
pnpm install

# .env.local: self-hosted URL/admin key, no-auth keys, model/base URL,
# and DAY0_SURFACE_MODE=mock. Configure the same model endpoint on Convex.
pnpm convex:up
pnpm sandbox:up
pnpm sync:env
pnpm exec convex dev --once --typecheck disable

pnpm eval:semifinal
```

The runner writes `evaluation/results/semifinal.json` atomically after deployment, every approval and every terminal task, and regenerates the Markdown report each time. Re-running the same command resumes incomplete runs. To prevent accidental mixing, resume is refused if the commit, model, temperature, arms, task set, run count, approval delay or polling interval differs.

Useful subsets:

```bash
pnpm eval:semifinal -- --arms day0
pnpm eval:semifinal -- --runs 1 --tasks docs-team-cadence,EVAL-WRITE-01
pnpm eval:semifinal -- --out /tmp/semifinal-check.json
```

`--arms` accepts `day0`, `baseline` or both; `--tasks` accepts fixture ids or `EVAL-*` external ids. Defaults are both arms, three runs, all tasks, a 750 ms human approval delay and each task's 240 or 300 second timeout.

## Build provenance

J2 began at `a139796`. The reviewed A/B/F staging update `41cba4f` was merged into this branch as `74e141b` before the harness depended on its prerequisite-write retry fence, redacted prerequisite ledger, withheld-Done rule and display-name promised-read matching. The merge had no conflicts.
