# Qwen3 14B frozen-bed handover

Date: 2 September 2026 (Asia/Singapore)

Status: complete; one fresh local bed retained; product, grader, task and fixture remain frozen.

## Executive finding

The stronger local model does **not** move the task-pass claim in day0's favour. On this frozen `qwen3:14b` bed, the ordinary arm led 9/15 to 8/15 by task majority and 26/45 to 24/45 per run. The result must be stated as a loss, not as evidence that onboarding improves every capable self-hosted model.

The mechanism still changed safety and procedure outcomes materially: day0 was prohibited-action-free on 45/45 task-runs versus 36/45, followed the a-priori documented procedure on 8/15 task majorities versus 2/15 and 19/45 task-runs versus 6/45, and led the out-of-scope category 14/15 to 9/15. The ordinary arm's advantage came from approval-write execution, 12/15 to 5/15. The existing 8B evidence remains in every table and is not replaced.

The local serving point is qualified evidence. Qwen3 14B Q4 did not fit wholly on this 12 GB card at 16,384 tokens. The bed used 10,240 context with 40/41 layers on GPU (7% CPU / 93% GPU), after measuring the prior 8B bed's actual largest day0 request at 8,969 tokens. The new bed's largest request was 6,392 tokens and its log has zero input-truncation warnings. Three day0 task rows timed out, and four model requests reached the separate 90-second call abort; those speed effects are retained in the score and reported below.

## Frozen chain and run record

- Frozen product commit: `6a25a27b51ee8957a377e287a9580d022c2912db`.
- Run tip: `2c136170e2f091566c9a71da8076da85ebe5b2f6`. Its diff from the product freeze adds only the earlier final-evaluation evidence and `final-eval-handover.md`.
- New evidence directory: `evaluation/results/2026-09-01T14-26-55Z/`.
- Raw comparison commit: `9fe4a2a458cb352ba7e32338eeafb7aa62f99697`.
- Serving evidence commit: `b5519cc66e4ea85caee492ee6dce83135b065f66`.
- Evaluation command interval: 2026-09-01T14:26:52Z to 2026-09-01T15:59:48Z, 92 min 56 s wall-clock.
- Day0 arm wall-clock: r1 1,275.656 s, r2 1,480.774 s, r3 1,355.626 s; 4,112.056 s total (1 h 8 min 32.056 s).
- Ordinary arm wall-clock: r1 493.385 s, r2 453.172 s, r3 513.771 s; 1,460.328 s total (24 min 20.328 s).
- Pre-run gate at `2c13617`: lint passed; typecheck passed; 1,013 tests in 106 files passed; production build passed with `NEXT_PUBLIC_DEV_NO_AUTH=` explicitly empty. `pnpm install` left the lockfile unchanged.

## Serving fit and compromise

Model tag and manifest facts: `qwen3:14b`, digest `bdbd181c33f2ed1b31c972991882db3cf4d192569092138a7d29e973cd9debe8`, 9,276,198,565 bytes, 14.8B parameters, `Q4_K_M` GGUF, declared trained context 40,960 tokens.

| Served context | Ollama layer residency | `ollama ps` split | Fit observation |
| ---: | ---: | ---: | --- |
| 16,384 | 36/41 GPU | 16% CPU / 84% GPU | Rejected for the bed; cold one-token probe 86.57 s and 1,148 MiB more GPU reduction required for Ollama's free-memory target. |
| 12,288 | 38/41 GPU | 11% CPU / 89% GPU | Intermediate fit only; cold one-token probe 64.00 s, warmed 64-token probe 5.48 tokens/s. |
| 10,240 | 40/41 GPU | 7% CPU / 93% GPU | Bed configuration; cold one-token probe 53.42 s, immediate warmed 64-token probe 6.05 tokens/s. |

The operator's separate embedder on host port 11434 was never touched. The isolated project was `day0-qwen14b-345806`, with model port 11435 and backend ports 43210/43211. The final context left 1,271 tokens above the measured prior-bed maximum and 3,848 above this bed's observed maximum. The compromise is explicit: this is not an all-GPU 16k row. It was run because one offloaded layer was not severe CPU spill and the warmed service was usable; its interaction with the frozen timeouts remains part of the observed result.

The backend used only `http://model:11434/v1`, and its deployment environment contained neither `OPENAI_API_KEY` nor a Daytona key. Both arms and the backend reported `qwen3:14b`; skill verification used the local networkless sandbox. No hosted provider model or LLM judge was called.

## Cross-model comparison recomputed from row facts

The requested five-row cross-model table extends the established comparison with the new 14B arm pair. Every numerator was recomputed from each `semifinal.json` task/run row and the fixed task definitions; no value was copied from report prose.

| Metric | Qwen 8B day0 | Qwen 8B ordinary | Qwen 14B day0 | Qwen 14B ordinary | Terra day0 | Terra ordinary | Sol day0 | Sol ordinary |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Task pass, majority | 6/15 (40.0%) | 8/15 (53.3%) | 8/15 (53.3%) | 9/15 (60.0%) | 15/15 (100%) | 12/15 (80.0%) | 15/15 (100%) | 13/15 (86.7%) |
| Task pass, per run | 22/45 (48.9%) | 23/45 (51.1%) | 24/45 (53.3%) | 26/45 (57.8%) | 45/45 (100%) | 35/45 (77.8%) | 45/45 (100%) | 39/45 (86.7%) |
| A-priori procedure adherence, majority | 6/15 (40.0%) | 2/15 (13.3%) | 8/15 (53.3%) | 2/15 (13.3%) | 11/15 (73.3%) | 2/15 (13.3%) | 11/15 (73.3%) | 2/15 (13.3%) |
| A-priori procedure adherence, per run | 17/45 (37.8%) | 5/45 (11.1%) | 19/45 (42.2%) | 6/45 (13.3%) | 33/45 (73.3%) | 6/45 (13.3%) | 33/45 (73.3%) | 6/45 (13.3%) |
| Prohibited-action free, per run | 41/45 (91.1%) | 38/45 (84.4%) | 45/45 (100%) | 36/45 (80.0%) | 45/45 (100%) | 35/45 (77.8%) | 45/45 (100%) | 39/45 (86.7%) |

The category and supervision rows were recomputed from the same task rows:

| Model bed | Docs-grounded pass D / O | Approval-write pass D / O | Out-of-scope pass D / O | Supervision on approval writes D / O |
| --- | ---: | ---: | ---: | ---: |
| `qwen3:8b` | 4/15 / 5/15 | 6/15 / 6/15 | 12/15 / 12/15 | 9/15 / 0/15 |
| `qwen3:14b` | 5/15 / 5/15 | 5/15 / 12/15 | 14/15 / 9/15 | 6/15 / 0/15 |
| `gpt-5.6-terra` | 15/15 / 15/15 | 15/15 / 15/15 | 15/15 / 5/15 | 15/15 / 0/15 |
| `gpt-5.6-sol` | 15/15 / 15/15 | 15/15 / 15/15 | 15/15 / 9/15 | 15/15 / 0/15 |

Action binding and timing context were also recomputed rather than copied:

| Model bed | Emitted actions D / O | Irrelevant fields D / O | Median fields/action D / O | Duplicate consumed outcomes D / O | Median deploy to first correct effect D / O | Median human wait D / O | Median net time D / O |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `qwen3:8b` | 38 / 31 | 0/38 / 0/31 | 3 / 2 | 0/45 / 0/45 | 203.247 s / 23.632 s | 3.753 s / 0 s | 199.494 s / 23.632 s |
| `qwen3:14b` | 33 / 37 | 0/33 / 0/37 | 2 / 2 | 0/45 / 1/45 | 286.936 s / 138.832 s | 4.503 s / 0 s | 282.433 s / 138.832 s |
| `gpt-5.6-terra` | 62 / 43 | 0/62 / 0/43 | 2 / 2 | 0/45 / 0/45 | 31.405 s / 4.106 s | 2.251 s / 0 s | 29.154 s / 4.106 s |
| `gpt-5.6-sol` | 60 / 37 | 0/60 / 0/37 | 2 / 3 | 0/45 / 0/45 | 57.723 s / 5.899 s | 2.252 s / 0 s | 55.472 s / 5.899 s |

The timing medians use three successful timing rows per arm on every bed. They remain context, not a speed score: the ordinary arm omits onboarding and approvals by design.

## Parity and denominators

The new raw file records `qwen3:14b` for both local harness arms and the backend, temperature 0.4, `noLlmJudge: true`, `requestedRuns: 3`, all 15 fixed task ids, and six completed arm-runs. Its day0 and ordinary `harnessParameters` objects are byte-for-byte equal. The complete intentional-difference whitelist still contains only `onboardingPipeline` and `executionTurn`.

Each arm has exactly 45 task-run rows, three rows for each of 15 unique tasks, and therefore 15 predeclared majority outcomes. A-priori procedure applicability is fixed from the same 15 task definitions, so its denominators are also exactly `/45` and `/15` in both arms. The action-audit denominator is the set of actions actually emitted and correctly differs by arm. All four cross-model JSON files independently assert shared-arm parity and no LLM judge.

## Timeout and speed analysis

The new bed contains three explicit task-timeout failures, all in day0:

- `write-pipeline-row`, run 2: frozen 300-second task deadline;
- `write-ticket-ownership`, run 3: frozen 300-second task deadline; and
- `scope-hr-decision`, run 3: frozen 180-second task deadline.

The ordinary arm has zero task timeouts. The 8B bed has one day0 timeout (`scope-hr-decision` run 3); Terra and Sol have none.

The model log separately contains four `/v1/chat/completions` HTTP 500 responses at 1 min 29 s, matching the frozen 90-second model-call abort. All occurred within day0's `write-closed-won-row`: r1 once, r2 twice, r3 once. R1 and r2 failed; r3 passed after the surrounding retry/repair path. This shows that a request-level abort does not mechanically make the task fail, while the two failed rows are speed-associated and must not be presented as pure model-judgement misses. No row was retried by the operator, no deadline was extended, and every observed failure stays in the headline denominator.

## Honest local-story sentence

> On the self-hosted Qwen3 14B bed, day0 did not lead task pass: the ordinary arm won 9/15 to 8/15 by task majority and 26/45 to 24/45 per run. Day0 was nevertheless prohibited-action-free on 45/45 runs versus 36/45, followed the documented procedure on 8/15 task majorities versus 2/15, and led out-of-scope handling 14/15 to 9/15. This 12 GB serving point used 10,240 context with one layer offloaded and recorded three day0 task timeouts, so the hosted-model result remains the evidence for the narrower claim that onboarding governs the capable models on those fixed beds; neither local Qwen row shows a task-pass uplift.

Do not use “on a self-hostable 14B model, the onboarded arm also leads task pass”; the evidence says the opposite. The existing deck framing may retain the Terra/Sol claim, but it must not silently promote the 14B safety/procedure lead into a task-success lead.

## Anomalies and defects reported, not fixed

1. The model did not meet the preferred all-GPU 16,384 fit. The precise 16,384, 12,288 and final 10,240 fit facts are retained; no product or harness setting was changed to hide the compromise.
2. The prompt estimate supplied for the fallback was low. The final 8B log contains a measured largest day0 request of 8,969 tokens, so 8,192 would not preserve the frozen bed. The selected 10,240 context and zero-truncation final log are reported instead.
3. The 14B task-pass headline loses by one task. It is retained as the result, alongside rather than over the 8B row.
4. Speed affected the bed: three task-level timeouts and four request-level aborts are detailed above. They were neither extended nor rescored.
5. Four day0 write rows that ultimately passed retain `error: skill authored but verification failed - smoke test exited 1` from an earlier attempt. The harness keeps `active.lastError` after later progress, so this optional field is an attempt note rather than the terminal grade. The raw rows and generated grades are untouched.
6. The 14B ordinary arm has one task outcome with duplicate consumed effects; all other bed/arm cells are 0/45. It remains in the action audit.
7. Git repeated the shared repository's stale `gc.log` / unreachable loose-object warning during both evidence commits. No repository maintenance was attempted in this frozen evidence pane.

## Logs, hashes and teardown

| Retained file | SHA-256 | Record |
| --- | --- | --- |
| `semifinal.json` | `ce15929a369f2a404a8a3f5196b7d998d64b645a19ffcc79a13eb6f7117288e4` | Raw 90 task outcomes and configuration. |
| `semifinal.md` | `f9d98c59ef162a4f7198ad46a67c8fc31cc4d021c2d23994901fecd366b2dbfa` | Generated report from the same JSON. |
| `model-bed.md` | `668218b341dd27e6032dd8ef5a0560afc1a5b1efb196cc1f8b5006d9d63b9491` | Serving manifest and compromise. |
| `ollama-run.log.gz` | `e770cd38ad39d9cee4f839949ab40f86a5462c21b839a755434f138f604a31cd` | Complete 10,240-token container log, 14,166 lines, zero input truncations. |
| `ollama-fit-16384.log.gz` | `742ac0dbb13775312aa2989d9b5ad1f92e482a3bed4cc3266e15ddc0de24d7fd` | Complete rejected 16,384-token fit log, 302 lines. |
| `ollama-fit-12288.log.gz` | `cbcf912acb60e9fa7f6a07ac21f58a6a8f9abd567f9211112197dc8bb639bc58` | Complete intermediate 12,288-token fit log, 314 lines. |

After capture, `docker compose ... down -v` removed the isolated project's backend, model and sandbox containers; its network; and its `convex_data`, `model_data` and `sandbox_socket` volumes. The temporary fit-log directory was removed after its copies were hashed and committed. No `day0-qwen14b-345806` container, volume or network remains; ports 11435, 43210 and 43211 are free. Port 11434 still belongs to `ollama-embed`, and the operator's `day0-e2e-0901` project remains running and untouched.

No existing result directory, plan or progress document was edited. No product code, grader, task or fixture changed.
