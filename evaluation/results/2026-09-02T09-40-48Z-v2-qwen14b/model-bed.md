# Harness v2 local model bed — Qwen3 14B

- Evaluation window: 2026-09-02T09:40:48Z to 2026-09-02T11:35:45Z (1 h 54 min 57 s).
- Harness commit: `906f9917a9fbac638855027f68f9db7d784d4e13`.
- Compose project: `day0-v2-qwen14b-75d448`; private volumes `day0-v2-qwen14b-75d448_convex_data`, `day0-v2-qwen14b-75d448_model_data` and `day0-v2-qwen14b-75d448_sandbox_socket`.
- Published ports: model 11435, Convex 43210/43211. The operator's `ollama-embed` remained on 11434.
- Model: `qwen3:14b`; Ollama id `bdbd181c33f2`; GGUF blob SHA-256 `a8cc1361f3145dc01f6d77c6c82c9116b9ffe3c97b34716fe20418455876c40e`.
- Serving point: `OLLAMA_CONTEXT_LENGTH=10240`, 40/41 layers offloaded; `ollama ps` reported 7% CPU / 93% GPU at preflight and after the run. The retained log records `n_ctx=10240`, the 40/41 offload, and zero input truncations or warning/error lines.
- Backend route: `http://model:11434/v1`; both arms and the deployment reported `qwen3:14b`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts x 75, 1 x 3, 2 x 1, 3 x 1, 5 x 1 and 6 x 9. Across the 45 Day0 rows: 0 attempts x 30, 1 x 3, 2 x 1, 3 x 1, 5 x 1 and 6 x 9.
- Completeness: 6/6 runs and 90/90 rows completed; zero harness timeouts and zero deadline overruns.
- Residual F8: the retained backend log contains zero action HTTP 500s and zero action-timeout signatures. Long-running action requests returned HTTP 200 throughout the bed.

## Retained files

- `ollama-run.log.gz`: complete model-container log from isolated project startup through the evaluation; 16,384 lines; SHA-256 `94946e1319f71e78a549b56355e58795cbf9a8bbc848e31653a837a45938c5f6`.
- `backend-run.log.gz`: complete backend-container log retained for the F8 audit; 1,241 lines; SHA-256 `66ac70e68b5851a99574d32148ea8c69b6cfdc9c697d42d8543ef43f300edc99`.
- `semifinal.json`: SHA-256 `490825415a419df91de71f2550313705cef7b9c97b00fb0e66c7058fd3f1a0e1`.
- `semifinal.md`: SHA-256 `8c01c70a68bb28a7d104c9a3c19c1b6f0a0f5a173fe15c6d828649cb1787a8ec`.
