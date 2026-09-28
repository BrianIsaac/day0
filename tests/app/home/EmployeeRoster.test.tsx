import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmployeeRoster } from '../../../app/home/EmployeeRoster';
import type { RosterRow } from '../../../app/home/types';

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
    autonomous: false,
    roleLine: 'Owns triage for tier-2 asks in #revops-asks',
    openCount: 1,
    parkedCount: 2,
    stoppedCount: 1,
    needsYou: 4,
    docSourceCount: 2,
    landedThisMonth: month([
      ['2026-09-03', 11],
      ['2026-09-17', 2],
    ]),
  },
  {
    agentId: 'synthetic-aiko',
    name: 'Aiko',
    state: 'charter-pending',
    autonomous: true,
    roleLine: 'charter pending',
    openCount: 0,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 1,
    docSourceCount: 0,
    landedThisMonth: month([['2026-09-20', 100]], true),
  },
] as unknown as RosterRow[];

const waiting = new Map([
  ['synthetic-mira', 3],
  ['synthetic-aiko', 1],
]);

/** The roster as a manager reads it at desktop: the stacked labels hidden, tags stripped. */
const readAs = (markup: string): string =>
  markup
    .replace(/<span class="[^"]*sm:hidden[^"]*">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('EmployeeRoster', (): void => {
  const html = renderToStaticMarkup(<EmployeeRoster employees={roster} waiting={waiting} />);

  it('is a table with a header per column, one row per employee', (): void => {
    const headers = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((match) => match[1]);
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
    expect(html).toContain('<th scope="row"');
  });

  it('stacks at a phone’s width: every row a two-column grid with each cell labelled', (): void => {
    expect(html).toMatch(/<table class="[^"]*max-sm:block/);
    expect(html).toMatch(/<thead class="[^"]*max-sm:sr-only/);
    expect(html).toMatch(/<tbody class="[^"]*max-sm:block/);
    const rows = [...html.matchAll(/<tbody[\s\S]*?<\/tbody>/g)][0][0].match(/<tr class="[^"]*"/g);
    expect(rows).toHaveLength(2);
    for (const row of rows ?? []) expect(row).toContain('max-sm:grid max-sm:grid-cols-2');
    const labels = [...html.matchAll(/<span class="[^"]*sm:hidden[^"]*">([^<]*)</g)].map(
      (match) => match[1],
    );
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
    expect(text).toContain('Mira Active Owns triage for tier-2 asks in #revops-asks asks first 3');
    expect(text).toContain('1 2 parked · 1 stopped 13');
    expect(text).toContain('Aiko Charter to review charter pending acts on its own 1 0 100+');
  });

  it('explains parked and stopped work on hover', (): void => {
    expect(html).toContain('title="Parked: waiting on a connection, a permission, a skill');
    expect(html).toContain('title="Stopped: ended short of done, with Retry on the card.');
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
    expect(text).toContain('asks first … 1');
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
