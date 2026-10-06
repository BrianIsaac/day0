import type { RunHold } from './item-display';

/*
 * What a pause holds besides the work loop's steps (the wave 12 review's D-8, recommendation (b);
 * wave 13 item 6): a skill's authoring and a system's orientation wait at the same gate as every
 * step (`stepMayRun`'s rule) and go on at the resume. These are the words a manager reads for one.
 */

/** A start a pause holds: a skill being written, or a system being oriented. */
export type HeldStart = 'authoring' | 'orientation';

/**
 * The line a held start leaves where the manager looks for it: the Skills card's attempt line for
 * an authoring (a clause the card sets in its own sentence), the system's card for an orientation
 * (a sentence of its own).
 *
 * @param hold - Whose pause holds it ({@link RunHold}).
 * @param start - What it holds.
 */
export function heldStartLine(hold: RunHold, start: HeldStart): string {
  const held =
    hold.by === 'employee'
      ? `held while ${hold.employeeName} is paused`
      : "held while this deployment's scheduled work is paused";
  const when =
    hold.by === 'employee' ? `when you resume ${hold.employeeName}` : 'once that work runs again';
  switch (start) {
    case 'authoring':
      return `${held}: writing it starts ${when}`;
    // The system's card shows this line on its own, so it is a sentence.
    case 'orientation':
      return `Orientation ${held}: it starts ${when}.`;
  }
}

/**
 * Why "Check for new work" did not start on a paused employee (W12-R29): intake reads nothing
 * while it is paused, so a check would spend its minute and find nothing.
 *
 * @param name - The employee's name.
 */
export function pausedCheckRefusal(name: string): string {
  return `${name} is paused: nothing is checked until you resume ${name} on Manage.`;
}
