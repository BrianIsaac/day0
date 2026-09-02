# Provider bed

- Command: `OPENAI_MODEL=gpt-5.6-terra pnpm eval:semifinal --runs 3 --out evaluation/results/2026-08-31T05-58-44Z/semifinal.json`
- Product commit under test: `449a3da6fc932b1048f1c19a91c11b30b9ad510a`
- Model reported by the isolated backend: `gpt-5.6-terra`
- Surface mode reported by the isolated backend: `mock`
- Browser and backend base URLs: unset, so both used the hosted provider endpoint
- Provider key: configured in the worktree and isolated backend; not retained in evidence
- Temperature: `0.4`
- Arms: `day0`, `baseline`
- Tasks: all 15 fixed semi-final tasks
- Runs: 3 per arm, 6/6 complete

This was the single hosted-provider verification after the interface change. No
hosted smoke probe or second provider evaluation was run. The ordinary-agent
baseline implementation was unchanged.
