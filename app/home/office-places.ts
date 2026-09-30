/** A place in the office, as a share of its width and height. */
export interface OfficePoint {
  readonly x: number;
  readonly y: number;
}

/** The spots an employee not at a desk stands at, in the corridors and the rooms' open floor. */
export const OFFICE_IDLE_SPOTS: readonly OfficePoint[] = [
  { x: 49, y: 17 },
  { x: 49, y: 32 },
  { x: 48, y: 48 },
  { x: 49, y: 62 },
  { x: 39, y: 57 },
  { x: 58, y: 56 },
  { x: 38, y: 83 },
  { x: 50, y: 86 },
  { x: 74, y: 37 },
  { x: 19, y: 37 },
];

/**
 * How far apart two figures' centres stand before they overlap, as a share of the office at a
 * desktop width: a figure is 144 by 140 px in an office about 880 px wide and 560 px tall. A phone
 * draws the same figures in a third of the width, so there they can still meet (recorded for the
 * design call on the phone office).
 */
export const FIGURE_SPAN: OfficePoint = { x: 17, y: 26 };

/** How far a roaming employee moves at least, so a step reads as a walk. */
const LEAST_STEP = 18;

/**
 * How clear a point is of the figures already placed: the nearest one's distance, in figures,
 * along whichever axis separates them most. At 1 or more the two do not overlap.
 *
 * @param point - Where a figure would stand.
 * @param placed - Where the others stand.
 */
export function clearance(point: OfficePoint, placed: readonly OfficePoint[]): number {
  return placed.reduce(
    (nearest, other) =>
      Math.min(
        nearest,
        Math.max(
          Math.abs(other.x - point.x) / FIGURE_SPAN.x,
          Math.abs(other.y - point.y) / FIGURE_SPAN.y,
        ),
      ),
    Number.POSITIVE_INFINITY,
  );
}

/** An employee standing somewhere other than a desk, and where it stood before, if anywhere. */
export interface IdleFigure {
  readonly agentId: string;
  /** A number of its own, so its first spot is its own and stays put between renders. */
  readonly seed: number;
  readonly previous?: OfficePoint;
}

/**
 * Where each idle employee stands: one at a time, each on a spot clear of the figures already
 * placed (the seated ones first), and of those the one that leaves the most clear spots to the
 * employees still to place, so two figures overlap only once the office has no clear spot left
 * (the hosted walk's m18: Ada's figure stood on Cleo's). Between equally good spots the first
 * placement follows each employee's own seed; a roaming step takes `pick`'s choice, away from
 * where the employee stood.
 *
 * @param idle - The idle employees, in roster order.
 * @param seated - Where the employees at desks sit.
 * @param pick - Chooses among equally good spots; the first by default, so a render is stable.
 * @returns Each idle employee's spot, by id.
 */
export function idlePlaces(
  idle: readonly IdleFigure[],
  seated: readonly OfficePoint[],
  pick: (spots: readonly OfficePoint[]) => OfficePoint = (spots) => spots[0],
): Record<string, OfficePoint> {
  const placed: OfficePoint[] = [...seated];
  const places: Record<string, OfficePoint> = {};
  for (const figure of idle) {
    const { previous } = figure;
    const away =
      previous === undefined
        ? []
        : OFFICE_IDLE_SPOTS.filter(
            (spot) => Math.abs(spot.x - previous.x) + Math.abs(spot.y - previous.y) > LEAST_STEP,
          );
    const reachable = away.length > 0 ? away : rotated(OFFICE_IDLE_SPOTS, figure.seed);
    // The spots still clear of everyone placed: a spot that takes fewer of them from the
    // employees still to place is the better of two clear ones.
    const open = OFFICE_IDLE_SPOTS.filter((spot) => clearance(spot, placed) >= 1);
    const scored = reachable.map((spot) => ({
      spot,
      clear: Math.min(1, clearance(spot, placed)),
      blocks: open.filter((other) => other !== spot && clearance(other, [spot]) < 1).length,
    }));
    const best = Math.max(...scored.map(({ clear }) => clear));
    const clearest = scored.filter(({ clear }) => clear === best);
    const fewest = Math.min(...clearest.map(({ blocks }) => blocks));
    const spot = pick(
      clearest.filter(({ blocks }) => blocks === fewest).map(({ spot: each }) => each),
    );
    places[figure.agentId] = spot;
    placed.push(spot);
  }
  return places;
}

/** The spots in order from the one a seed names, so employees prefer spots of their own. */
function rotated(spots: readonly OfficePoint[], seed: number): OfficePoint[] {
  const start = seed % spots.length;
  return [...spots.slice(start), ...spots.slice(0, start)];
}
