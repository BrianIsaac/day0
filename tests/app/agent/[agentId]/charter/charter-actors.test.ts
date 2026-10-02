import { describe, expect, it } from 'vitest';
import type { CharterConstraint } from '../../../../../src/agent/charter-constraints';
import {
  charterActors,
  READER_ACTED,
  type ActedVersion,
} from '../../../../../app/agent/[agentId]/charter/charter-actors';
import { actorAt } from '../../../../../app/agent/[agentId]/charter/CharterAside';

const EARLIER = 'sam@company.com';
const READER = 'ana@company.com';
const HANDED_OVER_AT = 5_000;

const actor = (at: number): string =>
  actorAt(at, [{ fromAddress: EARLIER, decidedAt: HANDED_OVER_AT }], READER);

const rule = (quote: string): CharterConstraint => ({
  kind: 'candidate-property',
  quote,
  wording: [quote],
  origin: 'manager',
});

const struck = { field: 'willNotDo' as const, text: 'Own forecasting.' };

function version(at: number, body: object, approved = true): ActedVersion {
  return { approved, createdAt: at, approvedAt: approved ? at : undefined, body };
}

describe('charterActors', () => {
  const versions = [
    version(9_000, { struckClauses: [struck], constraints: [rule('early'), rule('late')] }),
    version(2_000, { struckClauses: [struck], constraints: [rule('early')] }),
    version(1_000, { struckClauses: [struck] }),
    version(500, { struckClauses: [struck], constraints: [rule('draft only')] }, false),
  ];

  it('names the earlier manager for a strike first in force before the handover', () => {
    expect(charterActors(versions, actor, 9_000).struck(struck)).toBe(EARLIER);
  });

  it('dates a rule by the first version in force that carries it, ignoring a draft', () => {
    const actors = charterActors(versions, actor, 9_000);
    expect(actors.added(rule('early'))).toBe(EARLIER);
    expect(actors.added(rule('late'))).toBe('you');
    // Carried by an unapproved draft only, it falls back to the page's own version.
    expect(actors.added(rule('draft only'))).toBe('you');
  });

  it('dates an answer by its own time, and by the versions when the time does not parse', () => {
    const actors = charterActors(
      [version(3_000, { answeredQuestions: [{ question: 'Q', answer: 'A', answeredAt: 'x' }] })],
      actor,
      9_000,
    );
    expect(
      actors.answered({ question: 'Q', answer: 'A', answeredAt: new Date(3_000).toISOString() }),
    ).toBe(EARLIER);
    expect(
      actors.answered({ question: 'Q', answer: 'A', answeredAt: new Date(6_000).toISOString() }),
    ).toBe('you');
    expect(actors.answered({ question: 'Q', answer: 'A', answeredAt: 'x' })).toBe(EARLIER);
  });

  it('names whoever held the charter on the page while the versions load', () => {
    expect(charterActors(undefined, actor, 1_000).struck(struck)).toBe(EARLIER);
    expect(charterActors(undefined, actor, 9_000).struck(struck)).toBe('you');
  });

  it('says "you" for everything on a charter no handover touched', () => {
    expect(READER_ACTED.struck(struck)).toBe('you');
    expect(READER_ACTED.added(rule('early'))).toBe('you');
    expect(READER_ACTED.answered({ question: 'Q', answer: 'A', answeredAt: 'x' })).toBe('you');
  });
});
