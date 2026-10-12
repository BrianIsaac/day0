import { JSDOM } from 'jsdom';
import type { Id } from '../../convex/_generated/dataModel';
import { answers } from './signed-in/convex-react';
import { NOW, employeePage, home } from './signed-in/fixture';
import { route } from './signed-in/next-navigation';

/**
 * Print the signed-in pages as markup, one JSON object of page name to the markup inside the
 * page's `<main>`, for the browser job to mount under the build's stylesheet and check in both
 * themes (`signed-in-pages.spec.ts`). The pages need a backend and a signed-in session the job
 * does not hold (the proxy refuses `/agent/*` to a browser Clerk has not signed in), so each is
 * rendered from the product's own components over a fixture (`signed-in/fixture.ts`), in a jsdom
 * document, with every disclosure opened. It runs under `tsx` in its own process with
 * `signed-in/hooks.mjs`, which resolves `convex/react` and `next/navigation` to the fixture's
 * doubles, as the dashboard's jsdom suites stand in for them.
 */

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
// React's DOM renderer reads the browser's globals; the document's window lends them.
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: (): unknown => dom.window[name as keyof typeof dom.window],
    });
  }
}
// The fixture's clock: every wait, day and month reads the same on every run.
Date.now = (): number => NOW;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EmployeeShell } = await import('../../app/agent/[agentId]/EmployeeShell');
const { NeedsYouView } = await import('../../app/agent/[agentId]/NeedsYouView');
const { WorkView } = await import('../../app/agent/[agentId]/work/WorkView');
const { CharterView } = await import('../../app/agent/[agentId]/charter/CharterView');
const { PeopleView } = await import('../../app/agent/[agentId]/people/PeopleView');
const { DocumentationView } =
  await import('../../app/agent/[agentId]/documentation/DocumentationView');
const { SkillsView } = await import('../../app/agent/[agentId]/skills/SkillsView');
const { SurfacesView } = await import('../../app/agent/[agentId]/surfaces/SurfacesView');
const { RecordView } = await import('../../app/agent/[agentId]/record/RecordView');
const { ManageView } = await import('../../app/agent/[agentId]/manage/ManageView');
const { ReorientationView } =
  await import('../../app/agent/[agentId]/reorientation/ReorientationView');
const { TalkView } = await import('../../app/agent/[agentId]/reorientation/TalkRoom');
const { SignedInDashboard } = await import('../../app/home/SignedInDashboard');
const { RetiredNoticeProvider } = await import('../../app/RetiredNotice');

/** One page to print: its tab segment, its tree, and a text that says it has finished drawing. */
interface Page {
  readonly segment: string | null;
  readonly answers: () => Record<string, unknown>;
  readonly tree: () => ReturnType<typeof createElement>;
  readonly ready: string;
}

const tab = (
  segment: string | null,
  view: () => ReturnType<typeof createElement>,
  ready: string,
): Page => ({
  segment,
  answers: employeePage,
  tree: () =>
    createElement(EmployeeShell, { agentId: 'agent-1' as Id<'agents'>, children: view() }),
  ready,
});

/** The pages, by the name the spec checks them under. */
const PAGES: Readonly<Record<string, Page>> = {
  home: {
    segment: null,
    answers: home,
    tree: () =>
      createElement(
        RetiredNoticeProvider,
        null,
        createElement(SignedInDashboard, {
          boss: { email: 'boss@example.invalid', firstName: 'Boss' },
        }),
      ),
    ready: 'Company supervision',
  },
  'needs-you': tab(null, () => createElement(NeedsYouView), 'Nothing else is waiting on you'),
  work: tab('work', () => createElement(WorkView), 'Close REVOPS-9'),
  charter: tab('charter', () => createElement(CharterView), 'Close week takes'),
  people: tab('people', () => createElement(PeopleView), 'Named in the charter'),
  documentation: tab('documentation', () => createElement(DocumentationView), 'Team overview'),
  skills: tab('skills', () => createElement(SkillsView), 'update-linear-ticket'),
  surfaces: tab('surfaces', () => createElement(SurfacesView), 'Documentation it reads'),
  record: tab('record', () => createElement(RecordView), 'Every event'),
  manage: tab('manage', () => createElement(ManageView), 'Appearance'),
  reorientation: tab(
    'reorientation',
    () => createElement(ReorientationView),
    'charter assumed has changed',
  ),
  // A card's Discuss room (16-D), its talk under way.
  'reorientation-talk': tab(
    'reorientation',
    () => createElement(TalkView, { reorientationId: 'card-1' }),
    'Shall I put that on the card?',
  ),
};

/** The most turns a page may take to finish drawing (its lazily loaded panels among them). */
const TURNS = 300;

async function settle(): Promise<void> {
  await act(async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function draw(name: string, page: Page): Promise<string> {
  answers.clear();
  for (const [query, value] of Object.entries(page.answers())) answers.set(query, value);
  route.segment = page.segment;
  route.pathname = page.segment === null && name === 'home' ? '/' : '/agent/agent-1';
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  act((): void => root.render(page.tree()));
  for (let turn = 0; !(container.textContent ?? '').includes(page.ready); turn += 1) {
    if (turn === TURNS) throw new Error(`${name} never drew "${page.ready}"`);
    await settle();
  }
  // Every disclosure open: the drafts, logs and payloads inside are checked too.
  for (const disclosure of container.querySelectorAll('details')) disclosure.open = true;
  await settle();
  const html = container.innerHTML;
  act((): void => root.unmount());
  container.remove();
  return html;
}

const wanted = process.argv.slice(2);
const printed: Record<string, string> = {};
for (const [name, page] of Object.entries(PAGES)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  printed[name] = await draw(name, page);
}
// The pages' clocks and intervals would hold the process open, so it ends once the markup is out:
// a pipe takes the write asynchronously, and an exit before it drains loses the rest.
process.stdout.write(JSON.stringify(printed), () => process.exit(0));
