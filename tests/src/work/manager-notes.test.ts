import { describe, expect, it } from 'vitest';
import {
  digestDue,
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

describe('when a digest goes', (): void => {
  const topOfSingaporeHour = Date.UTC(2026, 8, 27, 16, 2);
  const quarterPast = Date.UTC(2026, 8, 27, 16, 17);

  it('sends a digest agent’s notes on the hour in its own zone, and not in the rest of the hour', (): void => {
    const agent = { managerNotifications: 'digest' as const, zone: 'Asia/Singapore' };
    expect(digestDue(agent, topOfSingaporeHour)).toBe(true);
    expect(digestDue(agent, quarterPast)).toBe(false);
    expect(digestDue({ ...agent, zone: 'Asia/Kolkata' }, topOfSingaporeHour)).toBe(false);
  });

  it('sends the notes a per-run agent kept before its switch at once, whatever the hour', (): void => {
    expect(digestDue({ managerNotifications: 'per-run' }, quarterPast)).toBe(true);
    expect(digestDue({}, quarterPast)).toBe(true);
  });
});

describe('the notes the gate writes for the manager', (): void => {
  const landed = [
    { kind: 'write' as const, line: 'Comment on REVOPS-7: "Done."' },
    { kind: 'write' as const, line: 'Move REVOPS-7 to Done on Linear', outcomeUnknown: true },
  ];

  it('says what landed when a run finished', (): void => {
    expect(
      landedNoteText({
        agentName: 'Priya',
        title: ' Add the  audit note ',
        rows: landed,
        outcome: 'completed',
      }),
    ).toBe(
      'Priya finished “Add the audit note”: 2 changes landed.\n- Comment on REVOPS-7: "Done."\n- Move REVOPS-7 to Done on Linear (outcome unknown)',
    );
    expect(
      landedNoteText({
        agentName: 'Priya',
        title: 'x',
        rows: landed.slice(0, 1),
        outcome: 'completed',
      }),
    ).toContain('1 change landed.');
  });

  it('asks for reconciliation when a run failed after landing work', (): void => {
    const text = landedNoteText({
      agentName: 'Priya',
      title: 'Close REVOPS-7',
      rows: [
        ...landed.slice(0, 1),
        { kind: 'read' as const, line: 'Read issue REVOPS-7 on Linear' },
      ],
      outcome: 'failed',
      reason: 'the status change was refused',
    });
    expect(text).toContain(
      'Priya stopped on “Close REVOPS-7” after 1 change landed: the status change was refused.',
    );
    expect(text).toContain('Reconcile the provider in day0 before a retry.');
  });

  it('records a stop with nothing landed', (): void => {
    expect(stoppedNoteText({ agentName: 'Priya', title: '', reason: 'no owner is set' })).toBe(
      'Priya stopped on “Untitled work”: no owner is set. Nothing landed; Retry stands in day0.',
    );
  });

  it('gathers notes into one digest, each stamped with its date and time in the agent’s zone, one blank line apart', (): void => {
    const morning = Date.UTC(2026, 8, 27, 23, 40);
    const evening = Date.UTC(2026, 8, 27, 9, 5);
    expect(
      digestText({
        agentName: 'Priya',
        zone: 'Asia/Singapore',
        notes: [
          { text: 'one', createdAt: evening },
          { text: 'two', createdAt: morning },
        ],
      }),
    ).toBe(
      'Priya: 2 updates since the last digest (times in Asia/Singapore).\n\n' +
        '27 Sep 2026, 17:05: one\n\n28 Sep 2026, 07:40: two',
    );
    expect(
      digestText({ agentName: 'Priya', zone: 'UTC', notes: [{ text: 'one', createdAt: evening }] }),
    ).toContain('1 update since');
  });

  it('closes a digest with what is still owed, the code where one was sent, and counts past ten', (): void => {
    const note = { text: 'one', createdAt: Date.UTC(2026, 8, 27, 9, 5) };
    const owed = [
      { title: 'Close REVOPS-7', decisionId: 'ab3xyz' },
      ...Array.from({ length: 11 }, (_, index) => ({ title: `Ask ${index + 1}` })),
    ];
    const text = digestText({ agentName: 'Priya', zone: 'UTC', notes: [note], owed });
    const block = text.split('\n\n').at(-1)?.split('\n') ?? [];
    expect(block[0]).toBe('Still waiting for your decision (12):');
    expect(block[1]).toBe('- “Close REVOPS-7”: reply “approve ab3xyz” or “reject ab3xyz <reason>”');
    expect(block[2]).toBe('- “Ask 1”: decide in day0');
    expect(block).toHaveLength(12);
    expect(block.at(-1)).toBe('…and 2 more in day0.');
    expect(digestText({ agentName: 'Priya', zone: 'UTC', notes: [note], owed: [] })).not.toContain(
      'Still waiting',
    );
  });

  it('names no code to reply with when the employee’s app takes no messages (W12V-7)', (): void => {
    const note = { text: 'one', createdAt: Date.UTC(2026, 8, 27, 9, 5) };
    const text = digestText({
      agentName: 'Iris',
      zone: 'UTC',
      notes: [note],
      owed: [{ title: 'Close REVOPS-7', decisionId: 'ab3xyz' }],
      typedCode: false,
    });
    expect(text).not.toContain('reply “approve');
    expect(text.split('\n').at(-1)).toBe('- “Close REVOPS-7”: decide in day0');
  });
});
