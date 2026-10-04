import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmployeeRoster } from '../../../app/home/EmployeeRoster';
import { OfficeWorld } from '../../../app/home/OfficeWorld';
import type { RosterRow } from '../../../app/home/types';
import type { OneToOnePhase } from '../../../src/agent/one-to-one-phase';
import { employeeStateWords, type EmployeeState } from '../../../src/work/state-labels';

const month = (days: Array<[string, number]>, atLeast = false) => ({
  month: '2026-09',
  days: days.map(([day, landed]) => ({ day, landed })),
  atLeast,
});

const roster = [
  {
    agentId: 'synthetic-mira',
    name: 'Mira',
    avatarId: 'face-05',
    state: 'active',
    phase: 'drafted',
    autonomous: false,
    roleLine: 'Owns triage for tier-2 asks in #revops-asks',
    openCount: 1,
    parkedCount: 2,
    parkedStates: { deferred: 0, needsSkill: 2, discovered: 0 },
    stoppedCount: 1,
    needsYou: 4,
    docSourceCount: 2,
    landedThisMonth: month([
      ['2026-09-03', 11],
      ['2026-09-17', 2],
    ]),
    decisionsReach: { kind: 'dm', channel: 'Slack', buttons: true },
  },
  {
    agentId: 'synthetic-aiko',
    name: 'Aiko',
    state: 'charter-pending',
    phase: 'drafted',
    autonomous: true,
    roleLine: 'charter pending',
    openCount: 0,
    parkedCount: 0,
    parkedStates: { deferred: 0, needsSkill: 0, discovered: 0 },
    stoppedCount: 0,
    needsYou: 1,
    docSourceCount: 0,
    landedThisMonth: month([['2026-09-20', 100]], true),
    decisionsReach: { kind: 'dashboard' },
  },
] as unknown as RosterRow[];

const waiting = new Map([
  ['synthetic-mira', 3],
  ['synthetic-aiko', 1],
]);

/** The roster as a manager reads it at desktop: the stacked labels hidden, tags stripped. */
const readAs = (markup: string): string =>
  markup
    .replace(/<span aria-hidden="true" class="[^"]*sm:hidden[^"]*">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('EmployeeRoster', (): void => {
  const html = renderToStaticMarkup(<EmployeeRoster employees={roster} waiting={waiting} />);

  it('is a table with a header per column, one row per employee', (): void => {
    const headers = [...html.matchAll(/<th scope="col" role="columnheader"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(headers).toEqual([
      'Employee',
      'State',
      'Role',
      'Autonomy',
      'Needs you',
      'In progress',
      'Landed this month',
    ]);
    expect(html.match(/<tr\b/g)).toHaveLength(3);
    expect(html).toContain('<th scope="row" role="rowheader"');
    expect(html.match(/<td role="cell"/g)).toHaveLength(12);
  });

  it('stacks at a phone’s width: every row a two-column grid with each cell labelled', (): void => {
    expect(html).toMatch(/<table role="table" class="[^"]*max-sm:block/);
    expect(html).toMatch(/<thead role="rowgroup" class="[^"]*max-sm:sr-only/);
    expect(html).toMatch(/<tbody role="rowgroup" class="[^"]*max-sm:block/);
    const rows = [...html.matchAll(/<tbody[\s\S]*?<\/tbody>/g)][0][0].match(
      /<tr role="row" class="[^"]*"/g,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows ?? []) expect(row).toContain('max-sm:grid max-sm:grid-cols-2');
    const labels = [
      ...html.matchAll(/<span aria-hidden="true" class="[^"]*sm:hidden[^"]*">([^<]*)</g),
    ].map((match) => match[1]);
    expect(labels.slice(0, 6)).toEqual([
      'State',
      'Role',
      'Autonomy',
      'Needs you',
      'In progress',
      'Landed this month',
    ]);
  });

  it('prints each employee’s state, role, autonomy, what waits on the manager, work and landings', (): void => {
    const text = readAs(html);
    expect(html).toContain('href="/agent/synthetic-mira"');
    // Walk m10: the page's words, Supervised or Autonomous, and the Work tab's state words.
    // Re-pinned for 12-M (H D6): where requests reach you is a line under the autonomy pill.
    expect(text).toContain(
      'Mira Active Owns triage for tier-2 asks in #revops-asks Supervised Requests: Slack DM, buttons 3',
    );
    expect(text).toContain('1 2 waiting on a skill · 1 stopped 13');
    expect(text).toContain(
      'Aiko Charter to review charter pending Autonomous Requests: dashboard only 1 0 100+',
    );
  });

  it('says an employee not yet met is waiting for the one-to-one, in the warn hue the page’s pill uses (review m8)', (): void => {
    const deployed = [
      { ...roster[0], agentId: 'synthetic-tomas', name: 'Tomas', state: 'deployed' },
    ] as unknown as RosterRow[];
    const markup = renderToStaticMarkup(<EmployeeRoster employees={deployed} waiting={waiting} />);
    expect(readAs(markup)).toContain('Tomas Waiting for your one-to-one');
    expect(markup).toMatch(
      /<span class="[^"]*text-\[var\(--color-warn\)\][^"]*">Waiting for your one-to-one<\/span>/,
    );
  });

  it('says Paused on a paused employee’s chip and face, in the warn hue (12-P)', (): void => {
    const paused = [{ ...roster[0], paused: true }] as unknown as RosterRow[];
    const markup = renderToStaticMarkup(<EmployeeRoster employees={paused} waiting={waiting} />);
    expect(readAs(markup)).toContain('Mira Paused');
    expect(markup).toMatch(/<span class="[^"]*text-\[var\(--color-warn\)\][^"]*">Paused<\/span>/);
    expect(markup).toContain('title="Mira, paused"');
  });

  it("explains parked and stopped work on hover, in the Work tab glossary's words", (): void => {
    expect(html).toContain(
      'title="Waiting on a skill: waiting on a skill you approve. The ones only you can release are in Needs you."',
    );
    expect(html).toContain('title="Stopped: ended short of done, with Retry on the card.');
  });

  it('points only the work the manager can release at Needs you, never a row waiting on a slot (second review x10)', (): void => {
    const waitingOnSlot = [
      { ...roster[0], parkedCount: 1, parkedStates: { deferred: 0, needsSkill: 0, discovered: 1 } },
    ] as RosterRow[];
    const html = renderToStaticMarkup(
      <EmployeeRoster employees={waitingOnSlot} waiting={waiting} />,
    );
    const title = /title="(Discovered:[^"]*)"/.exec(html)?.[1];
    expect(title).toBeDefined();
    expect(title).not.toContain('only you can release');
  });

  it('names each kind of parked work by the state the Work tab shows it in (walk m10)', (): void => {
    const parked = [
      {
        ...roster[0],
        stoppedCount: 0,
        parkedCount: 6,
        parkedStates: { deferred: 1, needsSkill: 2, discovered: 3 },
      },
    ] as unknown as RosterRow[];
    expect(
      readAs(renderToStaticMarkup(<EmployeeRoster employees={parked} waiting={waiting} />)),
    ).toContain('1 2 waiting on a skill · 1 parked · 3 discovered 13');
  });

  it('reads a row from functions pushed before the split as parked, never failing the page', (): void => {
    const older = Object.fromEntries(
      Object.entries(roster[0] as RosterRow).filter(([key]) => key !== 'parkedStates'),
    );
    const markup = renderToStaticMarkup(
      <EmployeeRoster employees={[older as unknown as RosterRow]} waiting={waiting} />,
    );
    expect(readAs(markup)).toContain('1 2 parked · 1 stopped 13');
  });

  it('says where each employee’s decisions reach you: a DM with buttons or typed codes, or here (12-M; H D6)', (): void => {
    const text = readAs(html);
    expect(text).toContain('Requests: Slack DM, buttons');
    expect(text).toContain('Requests: dashboard only');
    const typed = renderToStaticMarkup(
      <EmployeeRoster
        employees={[
          { ...roster[0]!, decisionsReach: { kind: 'dm', channel: 'Slack', buttons: false } },
        ]}
        waiting={waiting}
      />,
    );
    expect(readAs(typed)).toContain('Requests: Slack DM, typed codes');
  });

  it('heads the card with the headcount and one manager', (): void => {
    expect(readAs(html)).toContain('Roster 2 employees, one manager');
  });

  it('says there is nobody yet on a company with no employees', (): void => {
    const empty = readAs(renderToStaticMarkup(<EmployeeRoster employees={[]} waiting={waiting} />));
    expect(empty).toContain('Your employees 0 total');
    expect(empty).toContain('No employees yet. Deploy one above.');
  });

  it('leaves the needs-you count out until the inbox has loaded, so it never jumps', (): void => {
    const text = readAs(
      renderToStaticMarkup(<EmployeeRoster employees={roster} waiting={undefined} />),
    );
    // Re-pinned for 12-M: the requests line comes between autonomy and the count.
    expect(text).toContain('Supervised Requests: Slack DM, buttons loading 1');
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});

describe('the roster, its faces and the pill in every phase of the one-to-one (C2)', (): void => {
  const states: readonly EmployeeState[] = [
    'deployed',
    'day-one-in-progress',
    'charter-pending',
    'active',
  ];
  const phases: readonly OneToOnePhase['kind'][] = ['talking', 'drafting', 'failed', 'drafted'];
  const cases = states.flatMap((state) => phases.map((phase) => [state, phase] as const));

  it.each(cases)(
    'an employee %s whose one-to-one is %s reads the same everywhere',
    (state, phase) => {
      const row = { ...roster[0], state, phase } as RosterRow;
      const words = employeeStateWords(state, phase).text;
      const table = renderToStaticMarkup(<EmployeeRoster employees={[row]} waiting={waiting} />);
      expect(table).toMatch(new RegExp(`<span class="[^"]*rounded-full[^"]*">${words}</span>`));
      expect(table).toContain(`title="Mira, ${words.toLowerCase()}"`);
      const office = renderToStaticMarkup(<OfficeWorld agents={[row]} settled />);
      expect(office).toContain(`title="Mira, ${words.toLowerCase()}"`);
    },
  );

  it('says the charter is being drafted while the pill does, not that the one-to-one is on', (): void => {
    const row = { ...roster[0], state: 'day-one-in-progress', phase: 'drafting' } as RosterRow;
    const text = readAs(
      renderToStaticMarkup(<EmployeeRoster employees={[row]} waiting={waiting} />),
    );
    expect(text).toContain('Drafting the charter');
    expect(text).not.toContain('In your one-to-one');
  });
});
