# Superseded dry run (29 Aug 2026, qwen3:8b)

This is the harness's first end-to-end run, kept as history. It is not evidence
for the comparison and its numbers must not be quoted, for four reasons found in
the cross-model review of 30 Aug 2026:

1. It ran both arms on `qwen3:8b` through a local Ollama endpoint, not on the
   model the project is configured for, because the provider account had run
   out of credits.
2. The five out-of-scope task payloads stated their own expected outcome, and the
   grader's required-reason words were words from that same text; the control's
   15/15 refusals are the request echoed back. The control's task prompt also told
   it when to decline.
3. Both arms were granted scopes for systems the mock office does not have
   (`salesforce`, `pagerduty`, `northstar`), which contradicted the
   missing-permission tasks and removed day0's designed deferral.
4. The headless driver re-approved every day0 hold, so every day0 task carries a
   spurious backend error, and "time to operational" was a median over task
   positions rather than one value per run.

The task set, graders, driver and report have all changed since; a fresh run
from `pnpm eval:semifinal` writes to `evaluation/results/<timestamp>/`.
