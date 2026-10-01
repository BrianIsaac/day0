import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OfficeWorld } from '../../app/home/OfficeWorld';
import type { RosterRow } from '../../app/home/types';

/**
 * Print the home's mini office for a roster, for the browser job to mount under the build's
 * stylesheet and measure (`office.spec.ts`). The home needs a backend the job does not hold, so the
 * office is rendered from the component here, in its own process under `tsx`, as
 * `first-week-markup.ts` renders the week. The roster is named by the first argument.
 */

/** One employee of a printed roster: idle unless it has work open. */
function employee(index: number, working: boolean): RosterRow {
  return {
    agentId: `office-${index}`,
    name: `Pat ${index}`,
    avatarId: `face-0${(index % 8) + 1}`,
    state: 'active',
    autonomous: false,
    roleLine: 'Own routine revenue operations work from Linear tickets for the RevOps team.',
    openCount: working ? 1 : 0,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 0,
    docSourceCount: 12,
    phase: 'drafted',
  } as unknown as RosterRow;
}

/** The rosters a spec can ask for. */
const ROSTERS: Readonly<Record<string, readonly RosterRow[]>> = {
  // Ten standing: the desktop plan's ten idle spots, every one taken.
  'ten-idle': Array.from({ length: 10 }, (_, index) => employee(index, false)),
  // Ten on a phone, a tenth past the three rows the plan was ruled at, half of them at desks.
  'ten-mixed': Array.from({ length: 10 }, (_, index) => employee(index, index % 2 === 0)),
  // Ten at a desktop width, six of them at desks: the seats the review's bed (A-M1) found on
  // each other, the second's and the seventh's, and the eighth's against the fourth's, the
  // ninth's and the tenth's.
  'ten-six-seated': Array.from({ length: 10 }, (_, index) =>
    employee(index, [1, 3, 6, 7, 8, 9].includes(index)),
  ),
};

const roster = ROSTERS[process.argv[2] ?? ''];
if (roster === undefined) {
  throw new Error(`name a roster: ${Object.keys(ROSTERS).join(', ')}`);
}
process.stdout.write(
  renderToStaticMarkup(createElement(OfficeWorld, { agents: roster, settled: true })),
);
