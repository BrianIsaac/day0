export { HttpSpanModel, RedactorUnavailableError, spanModelFromEnv } from './client';
export type { ModelSpan, SpanModel } from './client';
export { guardReason, guardSecretSpan, NEVER_A_SECRET } from './guard';
export {
  dispositionFor,
  ENTITY_KINDS,
  ENTITY_POLICY,
  MODEL_LABELS,
  MODEL_THRESHOLD,
  REDACTION_CONTEXTS,
  REDACTOR_TIMEOUT_MS,
  REQUESTED_LABELS,
  THRESHOLDS,
} from './policy';
export type { Disposition, EntityKind, RedactionContext } from './policy';
export { personalDataMarker, REDACTED, redactStructural, redactText } from './redact';
export type { Finding, RedactedText, RedactionDegradation, RedactOptions } from './redact';
export { CONNECTION_PASSWORD, REFERENCE_START, structuralSpans, URL_SCHEME } from './structural';
