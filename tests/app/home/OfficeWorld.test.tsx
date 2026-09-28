import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfficeWorld } from '../../../app/home/OfficeWorld';
import type { RosterRow } from '../../../app/home/types';

const mira = {
  agentId: 'synthetic-mira',
  name: 'Mira',
  avatarId: 'face-05',
  state: 'active',
  autonomous: false,
  roleLine: 'Owns triage for tier-2 asks in #revops-asks',
  openCount: 1,
  parkedCount: 0,
  stoppedCount: 0,
  needsYou: 3,
  docSourceCount: 2,
} as unknown as RosterRow;

const idle = { ...mira, agentId: 'synthetic-idle', name: 'Aiko', openCount: 0 } as RosterRow;

describe('OfficeWorld', (): void => {
  it('renders every room lit, with no light-up state, before the script runs', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(html).not.toContain('data-seen');
    const rooms = [...html.matchAll(/class="day0-pixel-room day0-pixel-room-\w+ absolute"[^>]*>/g)];
    expect(rooms).toHaveLength(6);
  });

  it('numbers the rooms, desks, chairs and decor for the light-up stagger, each with a wash', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    for (let index = 0; index < 6; index += 1) {
      expect(html).toMatch(
        new RegExp(
          `class="day0-pixel-room [^"]*"[^>]*style="[^"]*--i:${index}"[^>]*><span class="day0-pixel-room-light" aria-hidden="true"></span>`,
        ),
      );
    }
    expect(html.match(/class="day0-pixel-desk [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(8);
    expect(html.match(/class="day0-pixel-chair [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(8);
    expect(html.match(/class="day0-pixel-decor [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(9);
  });

  it('shows the ready plate and the eight-desk minimum in an empty office', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    expect(html).toContain('office ready');
    expect(html).toContain('0 total');
  });

  it('titles a figure with the employee and what it is doing, nothing else (N6)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, idle]} />);
    expect(html).toContain('title="Mira, working at a desk"');
    expect(html).toContain('title="Aiko, roaming the office"');
    expect(html).not.toMatch(/title="[^"]* - /);
  });

  it('sets the name plate, the reads pill, the plate and the count at the 12 px floor', (): void => {
    const empty = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    const staffed = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(`${empty}${staffed}`).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(staffed).toContain('reads 2 locations');
    expect(staffed).toContain(mira.roleLine);
  });

  it('keeps a figure and its name plate inside the office at a phone width', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(html).toContain('left:clamp(4.5rem, 14%, calc(100% - 4.5rem))');
  });
});
