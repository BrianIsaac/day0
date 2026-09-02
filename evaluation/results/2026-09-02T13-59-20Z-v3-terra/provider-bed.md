# Harness v2 hosted model bed — GPT-5.6 Terra

- Evaluation window: 2026-09-02T14:00:00Z to 2026-09-02T14:22:37Z (22 min 37 s).
- Harness commit: `cbd6d79e1bc8c6cd178331b74c648f27ce8d0e07`.
- Compose project: `day0-v3-terra-abf333`; private volumes `day0-v3-terra-abf333_convex_data` and `day0-v3-terra-abf333_sandbox_socket`.
- Published ports: Convex 43210/43211. No model service was started and 11435 remained unpublished; the operator's `ollama-embed` remained on 11434.
- Model: `gpt-5.6-terra` through the provider default `https://api.openai.com/v1`; both `OPENAI_BASE_URL` and `CONVEX_OPENAI_BASE_URL` were empty in the private environment.
- Backend/model parity: both arms and the fresh deployment reported `gpt-5.6-terra`.
- Skill verification: local networkless sandbox; the fresh deployment environment contained no `DAYTONA_API_KEY`.
- Route proof before the bed: ordinary-arm `docs-team-cadence` completed and passed in 10.094 s through `@ai-sdk/openai Responses API through Mastra`, with three observable provider calls and one audited tool action. The former Chat Completions rejection was absent.
- Design: both arms, all 15 tasks, three runs per arm, 90 rows, requested temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline and at most six skill-authoring attempts. Fifteen recorded parity fields were deep-equal; the only intentional differences were `onboardingPipeline` and `executionTurn`.
- Attempt distribution across all 90 rows: 0 attempts x 78 and 1 x 12. Across the 45 Day0 rows: 0 attempts x 33 and 1 x 12.
- Completeness: 6/6 runs and 90/90 rows completed; 41/45 ordinary rows reached terminal state `completed`, the remaining four reached other recorded terminal states, and zero ordinary rows were rejected by the former route error. There were zero harness timeouts and zero deadline overruns.
- Residual F13: the recorded unsupported-temperature warning and null effective temperature are predicted from the model identifier by the harness, not observed from a provider response.

## Retained files

- `backend-run.log.gz`: complete backend-container log from isolated project startup through the evaluation; 1,226 lines; SHA-256 `675509b41fb3e02fc9461bd3fb6fa05c58d5d556972079f509d60fd5ccb767fe`.
- `semifinal.json`: SHA-256 `f37df63ba4910ece07eabfafbe6f3b7fe10d1e40264ce629e57f21cfcab76940`.
- `semifinal.md`: SHA-256 `cd770b68c446277518d06ee3b092a3554aa8f2e56b6bc72d52a93ea66d2a2ad2`.
