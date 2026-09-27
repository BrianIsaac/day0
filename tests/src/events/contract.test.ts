import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, isEventOf, isEventType } from '../../../src/events/contract';

describe('the event contract (decisions N10 and Q14)', (): void => {
  it('lists every type once', (): void => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('tells a listed type from anything else, an older release’s type included', (): void => {
    expect(isEventType('work.completed')).toBe(true);
    expect(isEventType('work.not-a-type')).toBe(false);
    expect(isEventType(42)).toBe(false);
  });

  it('narrows a stored row to the payload of the type it carries', (): void => {
    const row = { type: 'agent.zone-changed', payload: { from: 'UTC', to: 'Asia/Singapore' } };
    expect(isEventOf(row, 'agent.zone-changed') ? row.payload.to : undefined).toBe(
      'Asia/Singapore',
    );
    expect(isEventOf(row, 'agent.autonomy-changed')).toBe(false);
  });
});
