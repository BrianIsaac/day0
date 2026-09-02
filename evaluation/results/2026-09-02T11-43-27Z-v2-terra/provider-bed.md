# Harness v2 hosted model bed — GPT-5.6 Terra

- Evaluation window: 2026-09-02T11:43:27Z to 2026-09-02T12:02:12Z (18 min 45 s).
- Harness commit: `906f9917a9fbac638855027f68f9db7d784d4e13`.
- Compose project: `day0-v2-terra-4e7239`; private volumes `day0-v2-terra-4e7239_convex_data` and `day0-v2-terra-4e7239_sandbox_socket`.
- Published ports: Convex 43210/43211. No model service was started and 11435 remained unpublished; the operator's `ollama-embed` remained on 11434.
- Model: `gpt-5.6-terra` through the provider default `https://api.openai.com/v1`; both `OPENAI_BASE_URL` and `CONVEX_OPENAI_BASE_URL` were unset in the private environment.
- Backend/model parity: both arms and the fresh deployment reported `gpt-5.6-terra`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, requested temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts x 77 and 1 x 13. Across the 45 Day0 rows: 0 attempts x 32 and 1 x 13.
- Completeness: 6/6 runs and 90/90 rows completed; zero harness timeouts, zero deadline overruns and zero backend action-timeout signatures.
- Residual F6: all 45 ordinary-arm task-runs independently reached terminal failure because the provider rejected function tools with reasoning effort on `gpt-5.6-terra` through `/v1/chat/completions`. This is not a model-call timeout, but it invalidates Terra's cross-arm performance comparison; retain the row only as route-compatibility evidence.
- Residual F13: the recorded unsupported-temperature warning and null effective temperature are predicted from the model identifier by the harness, not observed from a provider response.

## Retained files

- `backend-run.log.gz`: complete backend-container log from isolated project startup through the evaluation; 1,200 lines; SHA-256 `98aaa87280273b873bfb4cacddf4234cfe707a4b39b431326332489fac0b3500`.
- `semifinal.json`: SHA-256 `2a4effaaf318c71bf8b078984242a838507e8a4fb344c3c7317f4910a448cb1e`.
- `semifinal.md`: SHA-256 `3de96f65f3c1788673c2b19b8a05c15f03493afb292c6216bd94fc1a0d383156`.
