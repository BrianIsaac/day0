# Local model-bed audit

This comparison ran only against the review-owned Compose project
`day0-review-5d30f7`. The host endpoint was
`http://127.0.0.1:11435/v1`; port 11434 was not used by this project. The
backend endpoint was `http://model:11434/v1` on that project's private Compose
network. Both endpoint probes reported `qwen3:8b`, and the evidence JSON records
the same backend model.

Before the run, Ollama reported:

```text
NAME        ID              SIZE      PROCESSOR    CONTEXT
qwen3:8b    500a1f067a9f    7.5 GB    100% GPU     16384
```

The model startup log reported:

```text
print_info: n_ctx_train           = 40960
llama_context: n_ctx         = 16384
llama_context: n_ctx_seq     = 16384
srv    load_model: initializing, n_slots = 1, n_ctx_slot = 16384, kv_unified = 'false'
```

The GPU was an NVIDIA GeForce RTX 5070 Ti Laptop GPU with 12,227 MiB total
VRAM. The qwen process used 7,350 MiB after load and remained 100% GPU; the
machine therefore fitted the 16,384-token Compose default without CPU spill.

`ollama-run.log.gz` is the complete model-container log for the evaluation
window, from `2026-08-31T03:15:48Z` through the evidence generation time
`2026-08-31T04:04:55.477Z`. It contains 16,045 lines and has SHA-256:

```text
bf2b0add0dc6d6656096e937e399c5e0bbe84a0a5048f00d25a431806da521b7
```

The complete window contains zero `truncating input prompt` warnings. Verify
the retained log without trusting this summary:

```bash
gzip -t ollama-run.log.gz
sha256sum ollama-run.log.gz
gzip -cd ollama-run.log.gz | wc -l
gzip -cd ollama-run.log.gz | grep -c 'truncating input prompt' || test $? -eq 1
```

The last command exits through grep status 1 when the count is zero.
