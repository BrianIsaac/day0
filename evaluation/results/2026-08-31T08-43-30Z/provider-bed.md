# Provider bed

- Evaluation window: 2026-08-31T08:43:36Z to 2026-08-31T09:03:14Z.
- Command: `OPENAI_MODEL=gpt-5.6-terra pnpm eval:semifinal --runs 3 --out evaluation/results/2026-08-31T08-43-30Z/semifinal.json`.
- Product commit under test: `d495b0fb731437028c9f8a6fb5fb4b38594a29f8` (the purity fixes at `050a9c9` plus the local Qwen evidence commit; no intervening product change).
- Model reported by the isolated backend: `gpt-5.6-terra`.
- Surface mode reported by the isolated backend: `mock`.
- Browser and backend model base URLs: unset, so both used the hosted provider endpoint.
- Provider key: configured in the worktree and isolated backend; not retained in evidence.
- Temperature: `0.4`.
- Arms: `day0`, `baseline`.
- Tasks: all 15 fixed semi-final tasks.
- Runs: 3 per arm, 6/6 complete.

This was the single hosted-provider verification after the purity changes. No hosted smoke probe or second provider evaluation was run.
