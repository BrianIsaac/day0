# Provider bed

- Evaluation window: 2026-08-31T09:55:32Z to 2026-08-31T10:15:06Z.
- Command: `OPENAI_MODEL=gpt-5.6-terra pnpm eval:semifinal --runs 3 --out evaluation/results/2026-08-31T09-55-00Z/semifinal.json`.
- Product commit under test: `f904aff86749cb5beb70473208866c7e3e21309f` (schema parity at `7bdb2e5` plus the final local Qwen evidence commit; no intervening product change).
- Model reported by the isolated backend: `gpt-5.6-terra`.
- Surface mode reported by the isolated backend: `mock`.
- Browser and backend model base URLs: unset, so both used the hosted provider endpoint.
- Provider key: configured in the worktree and isolated backend; not retained in evidence.
- Temperature: `0.4`.
- Arms: `day0`, `baseline`.
- Tasks: all 15 fixed semi-final tasks.
- Runs: 3 per arm, 6/6 complete.

This was the single hosted-provider verification after strict schema parity was established. No hosted smoke probe or second provider evaluation was run after that fix.
