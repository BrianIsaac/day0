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
 * desktop width: a figure is 144 by 140 px in an office about 880 px wide and 560 px tall.
 */
export const FIGURE_SPAN: OfficePoint = { x: 17, y: 26 };

/**
 * Where a phone stands its employees (below `sm`, the operator's ruling of 30 September): three
 * across and three down, as shares of the office's inner width (inside its 8 px frame) and of its
 * 560 px height. A phone figure is at most a third of the inner width wide (`app/globals.css`), so
 * three stand side by side at any phone width, and at 140 px tall the rows at 16, 50 and 84 keep
 * every figure inside the frame, its top edge included. Row by row, so the first three employees
 * stand side by side along the top.
 */
export const PHONE_SPOTS: readonly OfficePoint[] = [16, 50, 84].flatMap((y) =>
  [16.5, 50, 83.5].map((x) => ({ x, y })),
);

/**
 * How far apart two phone figures' centres stand before they overlap, in the phone plan's shares:
 * a figure is a third of the inner width less 6 px, under 33 percent at any phone width, and at
 * most 140 of the office's 560 px tall.
 */
export const PHONE_FIGURE_SPAN: OfficePoint = { x: 33, y: 25 };

/** Where an office stands its idle employees, and how far apart two must be not to overlap. */
export interface OfficePlan {
  readonly spots: readonly OfficePoint[];
  readonly span: OfficePoint;
}

/** The office at a desktop width: the corridors' and rooms' open floor. */
export const DESKTOP_PLAN: OfficePlan = { spots: OFFICE_IDLE_SPOTS, span: FIGURE_SPAN };

/** The office on a phone: the three-by-three plan. */
export const PHONE_PLAN: OfficePlan = { spots: PHONE_SPOTS, span: PHONE_FIGURE_SPAN };

/** Where the employee at this place on the roster sits at its desk on a phone. */
export function phoneSeat(index: number): OfficePoint {
  return PHONE_SPOTS[index % PHONE_SPOTS.length];
}

/** How far a roaming employee moves at least, so a step reads as a walk. */
const LEAST_STEP = 18;

/**
 * How clear a point is of the figures already placed: the nearest one's distance, in figures,
 * along whichever axis separates them most. At 1 or more the two do not overlap.
 *
 * @param point - Where a figure would stand.
 * @param placed - Where the others stand.
 * @param span - How far apart two figures stand before they overlap, in the plan's shares.
 */
export function clearance(
  point: OfficePoint,
  placed: readonly OfficePoint[],
  span: OfficePoint = FIGURE_SPAN,
): number {
  return placed.reduce(
    (nearest, other) =>
      Math.min(
        nearest,
        Math.max(Math.abs(other.x - point.x) / span.x, Math.abs(other.y - point.y) / span.y),
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
 * @param plan - The office's spots and figure span: the desktop's by default, or the phone's.
 * @returns Each idle employee's spot, by id.
 */
export function idlePlaces(
  idle: readonly IdleFigure[],
  seated: readonly OfficePoint[],
  pick: (spots: readonly OfficePoint[]) => OfficePoint = (spots) => spots[0],
  plan: OfficePlan = DESKTOP_PLAN,
): Record<string, OfficePoint> {
  const { spots, span } = plan;
  const placed: OfficePoint[] = [...seated];
  const places: Record<string, OfficePoint> = {};
  for (const figure of idle) {
    const { previous } = figure;
    const away =
      previous === undefined
        ? []
        : spots.filter(
            (spot) => Math.abs(spot.x - previous.x) + Math.abs(spot.y - previous.y) > LEAST_STEP,
          );
    const reachable = away.length > 0 ? away : rotated(spots, figure.seed);
    // The spots still clear of everyone placed: a spot that takes fewer of them from the
    // employees still to place is the better of two clear ones.
    const open = spots.filter((spot) => clearance(spot, placed, span) >= 1);
    const scored = reachable.map((spot) => ({
      spot,
      clear: Math.min(1, clearance(spot, placed, span)),
      blocks: open.filter((other) => other !== spot && clearance(other, [spot], span) < 1).length,
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
