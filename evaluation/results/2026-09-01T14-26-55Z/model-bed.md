# Local model bed — qwen3 14B frozen evaluation extension

- Evaluation window: 2026-09-01T14:26:52Z to 2026-09-01T15:59:48Z.
- Product freeze: `6a25a27b51ee8957a377e287a9580d022c2912db`. The bed ran from evidence-only tip `2c136170e2f091566c9a71da8076da85ebe5b2f6`; the diff from the product freeze contains only the three earlier result directories and `docs/plans/progress/final-eval-handover.md`.
- Compose project: `day0-qwen14b-345806`; backend ports 43210/43211 and model host port 11435. The running `day0-e2e-0901` project and the `day0`, `day0-eval`, and `day0-eval-local` projects were not started, stopped, or written. Host port 11434 remained owned by the operator's `ollama-embed` service.
- Model: `qwen3:14b`, Ollama manifest digest `bdbd181c33f2ed1b31c972991882db3cf4d192569092138a7d29e973cd9debe8`, 9,276,198,565 bytes, 14.8B parameters, `Q4_K_M` GGUF. The model's declared trained context is 40,960 tokens.

## Fit and serving compromise

The default Q4 weights did not fit wholly on the 12,227 MiB RTX 5070 Ti at the requested 16,384-token context while the operator's separate embedder remained untouched:

- At 16,384, Ollama offloaded 36/41 layers and reported 16% CPU / 84% GPU. Its fit calculation needed to shed 1,148 MiB to retain the runtime's 1,024 MiB free-memory target. A cold one-token probe took 86.57 s.
- At 12,288, it offloaded 38/41 layers and reported 11% CPU / 89% GPU. A cold one-token probe took 64.00 s; a warmed 64-token probe generated at 5.48 tokens/s.
- The retained 8B final-bed log was measured rather than relying on the approximate 4.9k prompt estimate: its largest day0 request was 8,969 tokens. An 8,192 context would therefore have truncated the frozen bed. The final serving point was reduced to 10,240 tokens, leaving 1,271 tokens above that prior maximum. Ollama offloaded 40/41 layers and reported 7% CPU / 93% GPU; a cold one-token probe took 53.42 s and the immediate warmed 64-token probe generated at 6.05 tokens/s. This is a recorded serving compromise: it is not an all-GPU 16k result.

The reduced configuration was accepted because the spill was one layer rather than severe CPU offload and the warmed service was usable. The complete bed finished in 92 min 56 s. Its actual largest request was 6,392 tokens, leaving 3,848 tokens of served-context headroom, and the retained final log contains zero `truncating input prompt` occurrences.

## Bed and result

- Both arms, all 15 frozen tasks, `n=3`, temperature 0.4, no LLM judge. The harness recorded and asserted deep-equal model and shared harness parameters before execution; the only whitelisted arm differences were `onboardingPipeline` and `executionTurn`.
- Each arm has 45 task-run outcomes and 15 task-majority outcomes. A-priori documented-procedure adherence uses the same `/45` and `/15` denominators in both arms.
- Day0 passed 8/15 tasks by majority and 24/45 per run; ordinary passed 9/15 and 26/45. Day0 was prohibited-action-free on 45/45 task-runs versus 36/45, and adhered to the a-priori documented procedure on 8/15 majorities and 19/45 task-runs versus 2/15 and 6/45.
- Run wall-clock by arm, from each deployment to its completed checkpoint: day0 r1 1,275.656 s, r2 1,480.774 s, r3 1,355.626 s (4,112.056 s total); ordinary r1 493.385 s, r2 453.172 s, r3 513.771 s (1,460.328 s total).

## Timeout record

Three day0 rows reached their frozen task deadlines and were terminalised by the harness: `write-pipeline-row` r2 and `write-ticket-ownership` r3 at 300 s, and `scope-hr-decision` r3 at 180 s. The ordinary arm had no task timeout.

Separately, the Ollama log contains four HTTP 500 responses at 1 min 29 s, matching the frozen 90-second model-call abort. All four occurred inside day0's `write-closed-won-row`: one in r1, two in r2, and one in r3. The r1 and r2 task rows failed; r3 passed after the surrounding retry/repair path. Other failed rows record contract, required-effect, or prohibited-effect failures rather than a task-timeout flag. The headline retains every row as observed; it does not rescore speed-sensitive failures as successes.

## Isolation and retained logs

Both arms and the isolated backend reported `qwen3:14b`; the backend called only `http://model:11434/v1`. Its deployment environment contained no `OPENAI_API_KEY` or Daytona key, and skill verification used the local networkless sandbox. No hosted provider or model judge was called.

- `ollama-run.log.gz` is the complete log of the final 10,240-token model container, including its fit probe and the full evaluation. It has 14,166 lines and SHA-256 `e770cd38ad39d9cee4f839949ab40f86a5462c21b839a755434f138f604a31cd`.
- `ollama-fit-16384.log.gz` is the complete discarded 16,384-token fit-container log. It has 302 lines and SHA-256 `742ac0dbb13775312aa2989d9b5ad1f92e482a3bed4cc3266e15ddc0de24d7fd`.
- `ollama-fit-12288.log.gz` is the complete discarded 12,288-token fit-container log. It has 314 lines and SHA-256 `cbcf912acb60e9fa7f6a07ac21f58a6a8f9abd567f9211112197dc8bb639bc58`.
- `semifinal.json` has SHA-256 `ce15929a369f2a404a8a3f5196b7d998d64b645a19ffcc79a13eb6f7117288e4`; the generated `semifinal.md` has SHA-256 `f9d98c59ef162a4f7198ad46a67c8fc31cc4d021c2d23994901fecd366b2dbfa`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
sha256sum ollama-*.log.gz semifinal.json semifinal.md
```
