import { describe, expect, it } from 'vitest';
import {
  acceptedWords,
  arrivingLine,
  acceptingCardLine,
  askedCardLine,
  askedWords,
  askLabel,
  changeAddressDescription,
  departedLine,
  endedCardLine,
  handedOverLine,
  handOverLines,
  leavesBehindLines,
  otherStandingLine,
  reportingElsewhereChoice,
  reportingElsewhereLead,
  retireBlockedByAcceptance,
  runsInFlightLine,
  takeOnLead,
  takesOnLines,
  zonedStamp,
} from '../../app/handover-words';
import { LOCAL_DEV_TRANSFER_REFUSAL } from '../../src/agent/manager-transfer';
import type { TransferPreview } from '../../convex/transferPreview';

/** 1 October 2026, 09:00 UTC. */
const ASKED = Date.UTC(2026, 9, 1, 9, 0);
/** Fourteen days on. */
const EXPIRES = Date.UTC(2026, 9, 15, 9, 0);

/** A preview of Maya, as `transferAcceptance.transferPreview` answers in real mode. */
const PREVIEW: TransferPreview = {
  transferId: 'transfer-1' as TransferPreview['transferId'],
  mode: 'real',
  employee: {
    agentId: 'agent-1' as TransferPreview['employee']['agentId'],
    name: 'Maya',
    state: 'active',
    roleLine: 'owns triage for tier-2 asks',
  },
  fromAddress: 'sam@kestrel.example',
  note: 'She is mid-way through the September close.',
  requestedAt: ASKED,
  expiresAt: EXPIRES,
  takesOn: {
    waiting: {
      oneToOne: 0,
      charter: 0,
      plan: 1,
      held: 0,
      skill: 0,
      parked: 0,
      stopped: 0,
      surface: 0,
    },
    openWork: 3,
    openWorkAtLeast: false,
    registeredSkills: 2,
    charter: { version: '0.2', approved: true },
    scopes: [{ scope: 'linear:read', source: 'surface' }, { scope: 'docs:read' }],
    recordLength: 41,
    recordAtLeast: false,
  },
  leavesBehind: {
    surfaces: [
      { slug: 'linear', displayName: 'Linear' },
      { slug: 'slack', displayName: 'Slack' },
    ],
    scopesRevoked: ['linear:read'],
    mirroredPages: 12,
    mirroredPagesAtLeast: false,
    autonomousActions: true,
  },
  reportingLines: ['Report blockers to Sam in #revops.'],
  documentation: [],
  runsInFlight: 0,
};

describe('zonedStamp', () => {
  it('stamps an instant in the zone given and names the zone (N12)', () => {
    expect(zonedStamp(ASKED, 'Asia/Singapore')).toBe('1 Oct 2026, 17:00, Asia/Singapore time');
  });
});

describe('the hand-over dialog (plan 7.1)', () => {
  it('says what happens in real mode, one line per cut system, in the plan’s order', () => {
    expect(
      handOverLines({
        name: 'Maya',
        mode: 'real',
        cutSystems: ['Linear', 'Slack'],
        expiresAt: EXPIRES,
        zone: 'UTC',
      }),
    ).toEqual([
      'Nothing changes until they accept. You keep every decision in the meantime, and you can cancel.',
      'When they accept, Maya becomes theirs. It leaves your home and your team, and this page closes to you.',
      'Its connection to Linear is cut. They approve it and connect it again with their own credentials.',
      'Its connection to Slack is cut. They approve it and connect it again with their own credentials.',
      'Credentials only Maya uses are revoked. Ones another employee or your documentation uses stay yours.',
      'Its record, charter, skills and lessons go with it. Your documentation stays yours.',
      'Unanswered, the request expires on 15 Oct 2026, 09:00, UTC time.',
    ]);
  });

  it('says the office goes with the employee in the hosted office, and names no credential', () => {
    const lines = handOverLines({
      name: 'Maya',
      mode: 'mock',
      cutSystems: ['Linear'],
      expiresAt: EXPIRES,
      zone: 'UTC',
    });
    expect(lines).toContain("In the hosted office, the office's systems go with Maya.");
    expect(lines.join(' ')).not.toMatch(/credential|is cut/);
  });

  it('labels the ask with the address typed, and with "them" before one is', () => {
    expect(askLabel(' lead@kestrel.example ')).toBe('Ask lead@kestrel.example');
    expect(askLabel('  ')).toBe('Ask them');
  });

  it('says the ask landed and that nothing changes until it is accepted', () => {
    expect(askedWords('Maya', 'lead@kestrel.example')).toBe(
      'Asked lead@kestrel.example to take Maya on. Nothing changes until they accept.',
    );
  });
});

describe('the Manager card (plan 7.1)', () => {
  it('says an asked request with both stamps in the zone named', () => {
    expect(
      askedCardLine({
        name: 'Maya',
        to: 'lead@kestrel.example',
        requestedAt: ASKED,
        expiresAt: EXPIRES,
        zone: 'UTC',
      }),
    ).toBe(
      'Handing over to lead@kestrel.example. Asked 1 Oct 2026, 09:00, UTC time; expires 15 Oct 2026, 09:00, UTC time. Maya works for you until they accept.',
    );
  });

  it('says an accepting request with the runs it waits on and its deadline', () => {
    const settleBy = Date.UTC(2026, 9, 2, 10, 15);
    expect(
      acceptingCardLine({
        name: 'Maya',
        to: 'lead@kestrel.example',
        runs: 2,
        settleBy,
        zone: 'UTC',
      }),
    ).toBe(
      'lead@kestrel.example accepted. Maya is finishing 2 runs; it becomes theirs when they end, by 2 Oct 2026, 10:15, UTC time at the latest.',
    );
    expect(
      acceptingCardLine({
        name: 'Maya',
        to: 'lead@kestrel.example',
        runs: 1,
        settleBy,
        zone: 'UTC',
      }),
    ).toContain('Maya is finishing 1 run; it becomes theirs when it ends');
  });

  it('says an accepting request whose run count is not read yet without a number', () => {
    expect(
      acceptingCardLine({
        name: 'Maya',
        to: 'lead@kestrel.example',
        runs: undefined,
        settleBy: Date.UTC(2026, 9, 2, 10, 15),
        zone: 'UTC',
      }),
    ).toBe(
      'lead@kestrel.example accepted. Maya is finishing its runs; it becomes theirs when they end, by 2 Oct 2026, 10:15, UTC time at the latest.',
    );
  });

  it('says an accepting request without a deadline when the row carries none', () => {
    expect(
      acceptingCardLine({
        name: 'Maya',
        to: 'lead@kestrel.example',
        runs: 1,
        settleBy: undefined,
        zone: 'UTC',
      }),
    ).toBe(
      'lead@kestrel.example accepted. Maya is finishing 1 run; it becomes theirs when it ends.',
    );
  });

  it('says that changing the address asks again, so the expiry starts again', () => {
    expect(changeAddressDescription('deputy@kestrel.example')).toBe(
      'The request to deputy@kestrel.example is cancelled and a new one is asked, so its 14 days start again.',
    );
  });

  it('says a decline with its reason quoted, one without, and an expiry', () => {
    const decidedAt = Date.UTC(2026, 9, 3, 8, 30);
    expect(
      endedCardLine(
        {
          state: 'declined',
          toAddress: 'lead@kestrel.example',
          decidedAt,
          declineReason: 'Not my team.',
        },
        'UTC',
      ),
    ).toBe('lead@kestrel.example declined on 3 Oct 2026, 08:30, UTC time: "Not my team."');
    expect(
      endedCardLine({ state: 'declined', toAddress: 'lead@kestrel.example', decidedAt }, 'UTC'),
    ).toBe('lead@kestrel.example declined on 3 Oct 2026, 08:30, UTC time.');
    expect(
      endedCardLine({ state: 'expired', toAddress: 'lead@kestrel.example', decidedAt }, 'UTC'),
    ).toBe('The request to lead@kestrel.example expired on 3 Oct 2026, 08:30, UTC time.');
  });

  it('flags an employee reporting to someone else in the plan’s words (section 11.2)', () => {
    expect(otherStandingLine('Maya', 'ana@kestrel.example')).toBe(
      'Maya reports to ana@kestrel.example, who is not you. From this release the manager is the account that owns the employee. Hand Maya over to ana@kestrel.example, or make yourself its manager.',
    );
  });

  it('says the local-dev line in the very words the backend refuses the ask with, one constant both read', () => {
    expect(LOCAL_DEV_TRANSFER_REFUSAL).toBe(
      'This installation signs everyone in as one manager. Handing over needs each manager to sign in as themselves (the customer-local profile).',
    );
  });
});

describe('the acceptance dialog (plan 7.3)', () => {
  it('leads with who asks, the role line and nothing for an employee without one', () => {
    expect(takeOnLead(PREVIEW)).toBe(
      'sam@kestrel.example manages Maya today and asks you to take over. Maya: owns triage for tier-2 asks.',
    );
    expect(takeOnLead({ ...PREVIEW, employee: { ...PREVIEW.employee, roleLine: null } })).toBe(
      'sam@kestrel.example manages Maya today and asks you to take over.',
    );
  });

  it('closes the role line once, whether it was clipped or written as a sentence', () => {
    const lead = (roleLine: string): string =>
      takeOnLead({ ...PREVIEW, employee: { ...PREVIEW.employee, roleLine } });
    expect(lead('owns triage…')).toMatch(/Maya: owns triage…$/);
    expect(lead('Owns triage.')).toMatch(/Maya: Owns triage\.$/);
  });

  it('leads what the new manager takes on with the decisions waiting on them, by kind (plan 7.3, U4-m5)', () => {
    const waiting = {
      ...PREVIEW.takesOn.waiting,
      plan: 1,
      held: 2,
      oneToOne: 1,
    };
    const none = { ...PREVIEW.takesOn.waiting, plan: 0 };
    expect(takesOnLines({ takesOn: { ...PREVIEW.takesOn, waiting: none } })[0]).toBe(
      '3 items in progress',
    );
    expect(takesOnLines({ takesOn: { ...PREVIEW.takesOn, waiting } })[0]).toBe(
      '4 decisions waiting: 1 one-to-one, 1 plan and 2 items with writes held',
    );
    const one = { ...PREVIEW.takesOn.waiting, plan: 0, surface: 1 };
    expect(takesOnLines({ takesOn: { ...PREVIEW.takesOn, waiting: one } })[0]).toBe(
      '1 decision waiting: 1 connection to approve',
    );
  });

  it('lists what the new manager takes on', () => {
    expect(takesOnLines(PREVIEW)).toEqual([
      '1 decision waiting: 1 plan',
      '3 items in progress',
      '2 skills',
      'charter version 0.2, approved',
      'permissions: linear:read and docs:read',
      'its record: 41 events, decisions included, as they were made',
    ]);
  });

  it('says a floor where the preview stopped counting, an unapproved charter and no scopes', () => {
    const lines = takesOnLines({
      ...PREVIEW,
      takesOn: {
        ...PREVIEW.takesOn,
        openWork: 200,
        openWorkAtLeast: true,
        registeredSkills: 1,
        charter: { version: '0.1', approved: false },
        scopes: [],
        recordLength: 200,
        recordAtLeast: true,
      },
    });
    expect(lines).toEqual([
      '1 decision waiting: 1 plan',
      'at least 200 items in progress',
      '1 skill',
      'no approved charter: you hold its Day-1 one-to-one',
      'permissions: none',
      'its record: at least 200 events, decisions included, as they were made',
    ]);
  });

  it('lists what does not come with the employee', () => {
    expect(leavesBehindLines(PREVIEW)).toEqual([
      'Linear: you approve and connect it with your own credentials',
      'Slack: you approve and connect it with your own credentials',
      "12 pages of sam@kestrel.example's documentation it stops reading",
      'autonomous actions: off until you turn them on',
    ]);
  });

  it('leaves the pages line out when no page stops being read', () => {
    expect(
      leavesBehindLines({
        ...PREVIEW,
        leavesBehind: { ...PREVIEW.leavesBehind, surfaces: [], mirroredPages: 0 },
      }),
    ).toEqual(['autonomous actions: off until you turn them on']);
  });

  it('says the runs in flight and the fifteen minutes', () => {
    expect(runsInFlightLine({ name: 'Maya', from: 'sam@kestrel.example', runs: 2 })).toBe(
      'Maya is finishing 2 runs for sam@kestrel.example. It becomes yours when they end, within 15 minutes.',
    );
  });

  it('says the employee is the acceptor’s, or becomes theirs when its runs end, as the acceptance answered', () => {
    expect(acceptedWords('Maya', 'accepted')).toBe('Maya is yours.');
    expect(acceptedWords('Maya', 'accepting')).toBe(
      'You accepted Maya. It becomes yours when its runs end.',
    );
  });

  it('says on the acceptor’s home an employee is on its way, its runs and the deadline in the viewer’s zone (M2)', () => {
    const settleBy = Date.UTC(2026, 9, 2, 11, 15);
    expect(
      arrivingLine({ name: 'Maya', from: 'sam@kestrel.example', runs: 1, settleBy, zone: 'UTC' }),
    ).toBe(
      'Maya is finishing 1 run for sam@kestrel.example and becomes yours when it ends, by 2 Oct 2026, 11:15, UTC time at the latest.',
    );
    expect(
      arrivingLine({
        name: 'Maya',
        from: 'sam@kestrel.example',
        runs: 0,
        settleBy: undefined,
        zone: 'UTC',
      }),
    ).toBe('Maya is finishing its runs for sam@kestrel.example and becomes yours when they end.');
  });
});

describe('the old manager’s notices (plan 7.4) and the home’s line (section 11.2)', () => {
  it('names where a handed-over employee went and since when', () => {
    const decidedAt = Date.UTC(2026, 9, 2, 11, 0);
    expect(handedOverLine('Maya', 'lead@kestrel.example', decidedAt, 'UTC')).toBe(
      'Maya now reports to lead@kestrel.example, since 2 Oct 2026, 11:00, UTC time.',
    );
    expect(departedLine('Maya', 'lead@kestrel.example', decidedAt, 'UTC')).toBe(
      'Maya reports to lead@kestrel.example since 2 Oct 2026, 11:00, UTC time. Its record went with it; your record of the handover is on your home.',
    );
  });

  it('counts the employees reporting to someone else, before naming them, and says where to choose', () => {
    expect(reportingElsewhereLead(3)).toBe('3 employees report to someone who is not you:');
    expect(reportingElsewhereChoice(3)).toBe("Choose on each one's People tab.");
    expect(reportingElsewhereLead(1)).toBe('1 employee reports to someone who is not you:');
    expect(reportingElsewhereChoice(1)).toBe('Choose on its People tab.');
  });
});

describe('the retire dialog during a handover (plan 7.5)', () => {
  it('says why retire waits while the handover is accepting', () => {
    expect(retireBlockedByAcceptance('Maya', 'lead@kestrel.example')).toBe(
      'lead@kestrel.example has accepted Maya; it is theirs once its runs finish.',
    );
  });
});
