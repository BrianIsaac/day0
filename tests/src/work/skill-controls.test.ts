import { describe, expect, it } from 'vitest';
import {
  allowlistChangedReason,
  givenUpReason,
  MAX_CONTROL_REASON_LENGTH,
  notCallableItemReason,
  reconnectedReason,
  strandedItemReason,
  controlReasonOf,
  RETIRED_BY_MANAGER,
  takenOutItemReason,
  withdrawnRunReason,
  WITHDRAWN_BY_MANAGER,
} from '../../../src/work/skill-controls';

describe('skill controls words', (): void => {
  it('says how many attempts a skill was given up after, in the singular and the plural', (): void => {
    expect(givenUpReason(1)).toBe('given up after 1 attempt');
    expect(givenUpReason(3)).toBe('given up after 3 attempts');
  });

  it('counts at least one attempt for a row that predates the count', (): void => {
    expect(givenUpReason(0)).toBe('given up after 1 attempt');
    expect(givenUpReason(Number.NaN)).toBe('given up after 1 attempt');
  });

  it('keeps the manager’s reason trimmed, and says who acted when there is none', (): void => {
    expect(controlReasonOf('  it closes the wrong tickets  ')).toBe('it closes the wrong tickets');
    expect(controlReasonOf('')).toBe(RETIRED_BY_MANAGER);
    expect(controlReasonOf('   ')).toBe(RETIRED_BY_MANAGER);
    expect(controlReasonOf(undefined)).toBe(RETIRED_BY_MANAGER);
    expect(controlReasonOf(' ', WITHDRAWN_BY_MANAGER)).toBe('withdrawn by the manager');
  });

  it('refuses a retire reason past the limit rather than cutting it', (): void => {
    expect(() => controlReasonOf('x'.repeat(MAX_CONTROL_REASON_LENGTH + 1))).toThrow(
      `Keep the reason to ${MAX_CONTROL_REASON_LENGTH} characters.`,
    );
    expect(controlReasonOf('x'.repeat(MAX_CONTROL_REASON_LENGTH))).toHaveLength(
      MAX_CONTROL_REASON_LENGTH,
    );
  });

  it('tells an item why it waits for a skill again, retired or withdrawn', (): void => {
    expect(takenOutItemReason('kanban-comment-and-close', 'retired')).toBe(
      'the skill kanban-comment-and-close was retired, so this waits for a skill again',
    );
    expect(takenOutItemReason('kanban-comment-and-close', 'withdrawn')).toBe(
      'the skill kanban-comment-and-close was withdrawn from every employee, so this waits for a skill again',
    );
  });

  it('tells an item the executor found no callable skill for that it waits for one to register', (): void => {
    expect(notCallableItemReason('kanban-comment-and-close')).toBe(
      'the skill kanban-comment-and-close is not callable yet, so this waits for it to register',
    );
  });

  it('names the surface in each re-check trigger’s reason', (): void => {
    expect(allowlistChangedReason('linear')).toBe('the tools you approved on linear changed');
    expect(reconnectedReason('linear')).toBe('its connection to linear was made again');
  });

  it('tells an item no proposal reached that it is evaluated afresh', (): void => {
    expect(strandedItemReason('kanban-comment-and-close')).toBe(
      'no proposal of the skill kanban-comment-and-close reached this item, so it is evaluated afresh',
    );
  });
});

describe('withdrawnRunReason', (): void => {
  it('says the run was stopped because its skill was withdrawn while it ran', (): void => {
    expect(withdrawnRunReason('kanban-comment-and-close')).toBe(
      'the skill kanban-comment-and-close was withdrawn from every employee while this ran',
    );
  });
});
