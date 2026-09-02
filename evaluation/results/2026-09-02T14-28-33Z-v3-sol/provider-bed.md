# Harness v2 hosted model bed — GPT-5.6 Sol

- Evaluation window: 2026-09-02T14:29:11Z to 2026-09-02T15:01:07Z (31 min 56 s).
- Harness commit: `cbd6d79e1bc8c6cd178331b74c648f27ce8d0e07`.
- Compose project: `day0-v3-sol-ebe7ea`; private volumes `day0-v3-sol-ebe7ea_convex_data` and `day0-v3-sol-ebe7ea_sandbox_socket`.
- Published ports: Convex 43210/43211. No model service was started and 11435 remained unpublished; the operator's `ollama-embed` remained on 11434.
- Model: `gpt-5.6-sol` through the provider default `https://api.openai.com/v1`; both `OPENAI_BASE_URL` and `CONVEX_OPENAI_BASE_URL` were empty in the private environment.
- Backend/model parity: both arms and the fresh deployment reported `gpt-5.6-sol`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, requested temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts x 78 and 1 x 12. Across the 45 Day0 rows: 0 attempts x 33 and 1 x 12.
- Completeness: 6/6 runs and 90/90 rows completed; 36/45 ordinary rows reached terminal state `completed`, the remaining nine reached other recorded terminal states, and zero ordinary rows were rejected by the former route error. There were zero harness timeouts, zero deadline overruns, zero backend action-timeout signatures and zero backend HTTP 500 signatures.
- Recorded outcome: Day0 run 2's `write-priya-verification` reached terminal state `failed` and was graded as a task failure; it was not a harness timeout and had no deadline overrun.
- Residual F13: the recorded unsupported-temperature warning and null effective temperature are predicted from the model identifier by the harness, not observed from a provider response.

## Retained files

- `backend-run.log.gz`: complete backend-container log from isolated project startup through the evaluation; 1,204 lines; SHA-256 `b754f785e107d889b92c39618b6b26bab5146e4977135b6d36c4cf85e88de259`.
- `semifinal.json`: SHA-256 `0da04c9141e3590ab23afd6cd1fb697b14b26c2326f936119c3b88b1e8ee59a8`.
- `semifinal.md`: SHA-256 `f35a649030a5f55171f30a421e39b257d435fa3fc9d7d1aaae4892a7cf3fef68`.
