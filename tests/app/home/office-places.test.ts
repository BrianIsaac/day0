import { describe, expect, it } from 'vitest';
import {
  clearance,
  FIGURE_SPAN,
  idlePlaces,
  OFFICE_IDLE_SPOTS,
} from '../../../app/home/office-places';

describe('where the office stands its idle employees (walk m18)', () => {
  it('measures clearance in figures, along the axis that separates two most', () => {
    expect(clearance({ x: 50, y: 50 }, [])).toBe(Number.POSITIVE_INFINITY);
    expect(clearance({ x: 50, y: 50 }, [{ x: 50 + FIGURE_SPAN.x, y: 50 }])).toBe(1);
    expect(clearance({ x: 50, y: 50 }, [{ x: 50, y: 50 + FIGURE_SPAN.y / 2 }])).toBe(0.5);
  });

  it('gives two employees who prefer the same spot two spots clear of each other', () => {
    const places = idlePlaces(
      [
        { agentId: 'a', seed: 0 },
        { agentId: 'b', seed: OFFICE_IDLE_SPOTS.length },
      ],
      [],
    );
    expect(clearance(places.b!, [places.a!])).toBeGreaterThanOrEqual(1);
  });

  it('keeps an idle employee off the one sitting at a desk in its way', () => {
    const desk = { x: 49, y: 20 };
    const places = idlePlaces([{ agentId: 'a', seed: 0 }], [desk]);
    expect(clearance(places.a!, [desk])).toBeGreaterThanOrEqual(1);
  });

  it('opens each employee on the same spot every render', () => {
    const idle = [
      { agentId: 'a', seed: 3 },
      { agentId: 'b', seed: 7 },
    ];
    expect(idlePlaces(idle, [])).toEqual(idlePlaces(idle, []));
  });

  it('walks each employee away from where it stood, to a spot clear of the others', () => {
    const start = idlePlaces(
      [
        { agentId: 'a', seed: 0 },
        { agentId: 'b', seed: 1 },
        { agentId: 'c', seed: 2 },
      ],
      [],
    );
    for (let step = 0; step < 20; step += 1) {
      const next = idlePlaces(
        Object.entries(start).map(([agentId, previous], seed) => ({ agentId, seed, previous })),
        [],
        (spots) => spots[Math.floor(Math.random() * spots.length)] ?? spots[0]!,
      );
      for (const [agentId, place] of Object.entries(next)) {
        const previous = start[agentId]!;
        expect(Math.abs(place.x - previous.x) + Math.abs(place.y - previous.y)).toBeGreaterThan(18);
      }
      const [a, b, c] = Object.values(next);
      expect(clearance(a!, [b!, c!])).toBeGreaterThanOrEqual(1);
      expect(clearance(b!, [c!])).toBeGreaterThanOrEqual(1);
    }
  });
});
