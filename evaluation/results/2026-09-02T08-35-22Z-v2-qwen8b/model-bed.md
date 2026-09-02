# Harness v2 local model bed — Qwen3 8B

- Evaluation window: 2026-09-02T08:35:22Z to 2026-09-02T09:23:50Z (48 min 28 s).
- Harness commit: `906f9917a9fbac638855027f68f9db7d784d4e13`.
- Compose project: `day0-v2-qwen8b-a871cc`; private volumes `day0-v2-qwen8b-a871cc_convex_data`, `day0-v2-qwen8b-a871cc_model_data` and `day0-v2-qwen8b-a871cc_sandbox_socket`.
- Published ports: model 11435, Convex 43210/43211. The operator's `ollama-embed` remained on 11434.
- Model: `qwen3:8b`; Ollama id `500a1f067a9f`; GGUF blob SHA-256 `a3de86cd1c132c822487ededd47a324c50491393e6565cd14bafa40d0b8e686f`.
- Serving point: `OLLAMA_CONTEXT_LENGTH=16384`, 37/37 layers offloaded, `ollama ps` reported 100% GPU. The retained log has one 16,384-context record and zero input-truncation warnings.
- Backend route: `http://model:11434/v1`; both arms and the deployment reported `qwen3:8b`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts × 78, 1 × 2, 2 × 2, 3 × 1, 4 × 4 and 6 × 3. The day0-only distribution is the same except that its zero-attempt count is 33.
- Completeness: 6/6 runs and 90/90 rows completed; zero harness timeouts, zero deadline overruns and zero action-timeout signatures.

## Retained files

- `ollama-run.log.gz`: complete model-container log from isolated project startup through the evaluation; 14,263 lines; SHA-256 `005d36cf7ea6deeef258e86ff6beb46e03669756bf648e59f9942839f6d4a201`.
- `semifinal.json`: SHA-256 `d426d8e15ee9fbdf2e927de22f1be43bf8c0ea0bdecc84ea1d33c92ff3040287`.
- `semifinal.md`: SHA-256 `c2a3278c3eee9928275ea4e274cb15c7808eb6b3751690dabbade05537db4a0a`.
