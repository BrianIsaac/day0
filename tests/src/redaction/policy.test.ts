import { describe, expect, it } from 'vitest';
import {
  dispositionFor,
  ENTITY_KINDS,
  ENTITY_POLICY,
  MODEL_LABELS,
  MODEL_THRESHOLD,
  REDACTION_CONTEXTS,
  REQUESTED_LABELS,
  THRESHOLDS,
} from '../../../src/redaction/policy';

describe('the entity policy', (): void => {
  it('covers every kind in every context', (): void => {
    for (const context of REDACTION_CONTEXTS) {
      for (const kind of ENTITY_KINDS) {
        expect(['redact', 'keep']).toContain(ENTITY_POLICY[context][kind]);
      }
    }
  });

  it('never keeps a secret and never redacts a person, a username or an infrastructure address', (): void => {
    for (const context of REDACTION_CONTEXTS) {
      expect(dispositionFor(context, 'secret')).toBe('redact');
      expect(dispositionFor(context, 'person')).toBe('keep');
      expect(dispositionFor(context, 'username')).toBe('keep');
      expect(dispositionFor(context, 'ip')).toBe('keep');
      for (const kind of ['phone', 'address', 'id-number', 'date-of-birth'] as const) {
        expect(dispositionFor(context, kind)).toBe('redact');
      }
    }
  });

  it('keeps an email address where a page names who to ask and removes it from what a provider echoed', (): void => {
    expect(dispositionFor('documentation', 'email')).toBe('keep');
    expect(dispositionFor('prompt', 'email')).toBe('keep');
    expect(dispositionFor('outcome', 'email')).toBe('redact');
    expect(dispositionFor('record', 'email')).toBe('redact');
    expect(dispositionFor('export', 'email')).toBe('redact');
  });

  it('asks the model for every label a policy row can act on, at the lowest threshold', (): void => {
    expect(REQUESTED_LABELS).toEqual(Object.keys(MODEL_LABELS));
    expect(new Set(Object.values(MODEL_LABELS))).toEqual(new Set(ENTITY_KINDS));
    expect(MODEL_THRESHOLD).toBe(Math.min(...Object.values(THRESHOLDS)));
    expect(THRESHOLDS.secret).toBeGreaterThanOrEqual(MODEL_THRESHOLD);
  });
});
