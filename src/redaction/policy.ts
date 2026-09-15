/**
 * The redaction policy, as data.
 *
 * Two jobs share one model call: secrets (passwords, keys, tokens) and
 * personal data (names, contact details, identifiers). What the model is
 * asked for, how sure it must be, and what happens to each kind of span in
 * each context is written here and nowhere else, so that a reader can see the
 * whole policy on one screen and a change to it is a change to a table.
 *
 * Contexts are the places text is persisted or shown:
 *   documentation  a page stored at sync and mirrored to agents
 *   outcome        a provider effect, reason or id persisted to the ledger
 *   record         a grounding read rendered to the planner and persisted
 *   prompt         already-stored material rendered into a model prompt
 *   export         the judge-facing trace
 *
 * Coworker names, channel names, ticket ids, dates, figures, URLs and audit
 * lines are the working material this system reads to do its job; no policy
 * row redacts them, and the guard keeps a model from doing so by accident.
 */

export const REDACTION_CONTEXTS = ['documentation', 'outcome', 'record', 'prompt', 'export'] as const;
export type RedactionContext = (typeof REDACTION_CONTEXTS)[number];

export const ENTITY_KINDS = [
  'secret',
  'person',
  'username',
  'email',
  'phone',
  'address',
  'id-number',
  'date-of-birth',
  'ip',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type Disposition = 'redact' | 'keep';

/** The labels the model is asked for, each mapped to the kind it reports. */
export const MODEL_LABELS: Readonly<Record<string, EntityKind>> = {
  password: 'secret',
  'api key': 'secret',
  'secret key': 'secret',
  'access token': 'secret',
  'private key': 'secret',
  credential: 'secret',
  'authentication token': 'secret',
  person: 'person',
  username: 'username',
  email: 'email',
  'phone number': 'phone',
  address: 'address',
  'id number': 'id-number',
  'date of birth': 'date-of-birth',
  'ip address': 'ip',
};

/** The score a span must reach before its kind's policy applies. */
export const THRESHOLDS: Readonly<Record<EntityKind, number>> = {
  secret: 0.4,
  person: 0.3,
  username: 0.3,
  email: 0.3,
  phone: 0.3,
  address: 0.3,
  'id-number': 0.3,
  'date-of-birth': 0.3,
  ip: 0.3,
};

/** The floor the model is asked at; a span below its kind's threshold is dropped after. */
export const MODEL_THRESHOLD = Math.min(...Object.values(THRESHOLDS));

/**
 * What each kind of span becomes in each context.
 *
 * A secret is never kept. A person, a username and an infrastructure address
 * are never redacted: they are how a runbook says who owns what and where a
 * system is. An email address is kept where a page names who to ask and
 * removed from what a provider echoed back or a ticket carried, because after
 * the call that made use of it nothing else does. Phone numbers, personal
 * addresses, government and account identifiers and dates of birth are never
 * working material.
 */
export const ENTITY_POLICY: Readonly<Record<RedactionContext, Readonly<Record<EntityKind, Disposition>>>> = {
  documentation: {
    secret: 'redact',
    person: 'keep',
    username: 'keep',
    email: 'keep',
    phone: 'redact',
    address: 'redact',
    'id-number': 'redact',
    'date-of-birth': 'redact',
    ip: 'keep',
  },
  outcome: {
    secret: 'redact',
    person: 'keep',
    username: 'keep',
    email: 'redact',
    phone: 'redact',
    address: 'redact',
    'id-number': 'redact',
    'date-of-birth': 'redact',
    ip: 'keep',
  },
  record: {
    secret: 'redact',
    person: 'keep',
    username: 'keep',
    email: 'redact',
    phone: 'redact',
    address: 'redact',
    'id-number': 'redact',
    'date-of-birth': 'redact',
    ip: 'keep',
  },
  prompt: {
    secret: 'redact',
    person: 'keep',
    username: 'keep',
    email: 'keep',
    phone: 'redact',
    address: 'redact',
    'id-number': 'redact',
    'date-of-birth': 'redact',
    ip: 'keep',
  },
  export: {
    secret: 'redact',
    person: 'keep',
    username: 'keep',
    email: 'redact',
    phone: 'redact',
    address: 'redact',
    'id-number': 'redact',
    'date-of-birth': 'redact',
    ip: 'keep',
  },
};

/** Labels whose kind the policy could redact somewhere, which is every label asked for. */
export const REQUESTED_LABELS: readonly string[] = Object.keys(MODEL_LABELS);

/**
 * Decide what a span of one kind becomes in one context.
 *
 * Args:
 *   context: Where the text is going.
 *   kind: The kind the model or the structural grammar reported.
 *
 * Returns:
 *   `redact` or `keep`.
 */
export function dispositionFor(context: RedactionContext, kind: EntityKind): Disposition {
  return ENTITY_POLICY[context][kind];
}

/** How long a single model call may take before the caller falls back. */
export const REDACTOR_TIMEOUT_MS = 10_000;
