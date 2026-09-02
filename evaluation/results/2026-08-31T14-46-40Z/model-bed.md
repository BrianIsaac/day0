# Local model bed — final Qwen verification

- Evaluation window: 2026-08-31T14:46:40Z to 2026-08-31T15:34:24Z.
- Product commit: `34a933c19de784d3dd8ae639e845155d83f4493a`.
- Compose project: `day0-runbook-e1c11e`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend. Port 11434 on the host was not used.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; `ollama ps` reported context 16384 after the run and the retained interval log contains zero `truncating input prompt` warnings.
- Accelerator: `ollama ps` reported 100% GPU after the run.
- Model volume: `day0-runbook-e1c11e_model_data`, copied from `day0-eval-local_model_data` while the source was mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both arms used the same local model endpoint and the isolated backend reported `qwen3:8b`. No LLM judge was used.
- Outcome: day0 task pass 7/15 majority and 21/45 per run; prohibited-action-free 39/45; scope 12/15; a-priori procedure adherence 6/15 majority and 19/45 per run; legacy outcome-conditioned adherence 7/9 majority and 19/23 per run. Relative to the pre-mechanism Qwen bed, a-priori adherence increased from 15/45 to 19/45, but task pass remained below 25/45, prohibited-action-free improved from 37/45, and scope regressed from 13/15. This is retained as a model-capability finding, not accepted as meeting every target.

`ollama-run.log.gz` retains the complete model-container log for this evaluation interval. It has 16,039 lines and SHA-256 `354bad40a2be53cf7c235dc294883ea919b0a590e54d616b28abbd8cc1265709`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
