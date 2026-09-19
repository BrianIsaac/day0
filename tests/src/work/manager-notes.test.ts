import { describe, expect, it } from 'vitest';
import {
  digestText,
  landedNoteText,
  managerNotificationMode,
  stoppedNoteText,
} from '../../../src/work/manager-notes';

describe('the manager notification mode', (): void => {
  it('reads an absent field as per run', (): void => {
    expect(managerNotificationMode({})).toBe('per-run');
    expect(managerNotificationMode({ managerNotifications: 'digest' })).toBe('digest');
  });
});

describe('the notes the gate writes for the manager', (): void => {
  const landed = [
    { kind: 'write' as const, line: 'Comment on REVOPS-7: "Done."' },
    { kind: 'write' as const, line: 'Move REVOPS-7 to Done on Linear', outcomeUnknown: true },
  ];

  it('says what landed when a run finished', (): void => {
    expect(
      landedNoteText({ agentName: 'Priya', title: ' Add the  audit note ', rows: landed, outcome: 'completed' }),
    ).toBe('Priya finished “Add the audit note”: 2 changes landed.\n- Comment on REVOPS-7: "Done."\n- Move REVOPS-7 to Done on Linear (outcome unknown)');
    expect(
      landedNoteText({ agentName: 'Priya', title: 'x', rows: landed.slice(0, 1), outcome: 'completed' }),
    ).toContain('1 change landed.');
  });

  it('asks for reconciliation when a run failed after landing work', (): void => {
    const text = landedNoteText({
      agentName: 'Priya',
      title: 'Close REVOPS-7',
      rows: [...landed.slice(0, 1), { kind: 'read' as const, line: 'Read issue REVOPS-7 on Linear' }],
      outcome: 'failed',
      reason: 'the status change was refused',
    });
    expect(text).toContain('Priya stopped on “Close REVOPS-7” after 1 change landed: the status change was refused.');
    expect(text).toContain('Reconcile the provider in day0 before a retry.');
  });

  it('records a stop with nothing landed', (): void => {
    expect(stoppedNoteText({ agentName: 'Priya', title: '', reason: 'no owner is set' })).toBe(
      'Priya stopped on “Untitled work”: no owner is set. Nothing landed; Retry stands in day0.',
    );
  });

  it('gathers notes into one digest', (): void => {
    expect(digestText({ agentName: 'Priya', notes: [{ text: 'one' }, { text: 'two' }] })).toBe(
      'Priya: 2 updates since the last digest.\n\n\n\none\n\ntwo',
    );
    expect(digestText({ agentName: 'Priya', notes: [{ text: 'one' }] })).toContain('1 update since');
  });
});
