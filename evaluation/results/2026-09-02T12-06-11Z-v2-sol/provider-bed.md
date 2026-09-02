# Harness v2 hosted model bed — GPT-5.6 Sol

- Evaluation window: 2026-09-02T12:06:11Z to 2026-09-02T12:30:14Z (24 min 3 s).
- Harness commit: `906f9917a9fbac638855027f68f9db7d784d4e13`.
- Compose project: `day0-v2-sol-fbcb0c`; private volumes `day0-v2-sol-fbcb0c_convex_data` and `day0-v2-sol-fbcb0c_sandbox_socket`.
- Published ports: Convex 43210/43211. No model service was started and 11435 remained unpublished; the operator's `ollama-embed` remained on 11434.
- Model: `gpt-5.6-sol` through the provider default `https://api.openai.com/v1`; both `OPENAI_BASE_URL` and `CONVEX_OPENAI_BASE_URL` were unset in the private environment.
- Backend/model parity: both arms and the fresh deployment reported `gpt-5.6-sol`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, requested temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts x 78 and 1 x 12. Across the 45 Day0 rows: 0 attempts x 33 and 1 x 12.
- Completeness: 6/6 runs and 90/90 rows completed; zero harness timeouts, zero deadline overruns and zero backend action-timeout signatures.
- Residual F6: all 45 ordinary-arm task-runs independently reached terminal failure because the provider rejected function tools with reasoning effort on `gpt-5.6-sol` through `/v1/chat/completions`. This is not a model-call timeout, but it invalidates Sol's cross-arm performance comparison; retain the row only as route-compatibility evidence.
- Residual F13: the recorded unsupported-temperature warning and null effective temperature are predicted from the model identifier by the harness, not observed from a provider response.

## Retained files

- `backend-run.log.gz`: complete backend-container log from isolated project startup through the evaluation; 1,187 lines; SHA-256 `d909436362276a2b471c6cab89cdace14ff0a4935c2f499f9db31a0a29e833fe`.
- `semifinal.json`: SHA-256 `cfd6a8dfcd3f24acc23ac26250810116ec7434b37796ef75043328721037c125`.
- `semifinal.md`: SHA-256 `b9503a1c8ba2b8127d267562bb9ff6ce511aa13db43f180ce92a09397978abbd`.
