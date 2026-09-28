/**
 * Every sentence the signed-out landing page shows, in one place. The words are round four's
 * (`docs/design/proposal-claude-v4-2026-09-27.md` section 1.1 and the prototype's landing page)
 * and follow decision N29: the thing a manager manages is an "employee"; "agent" survives only
 * as the industry's word for the software Day0 is contrasted with.
 */

/** The repository every public "GitHub" link opens. */
export const REPOSITORY_URL = 'https://github.com/BrianIsaac/day0';

/** The README's disclosures: what is simulated, who receives what, and the third parties. */
export const DISCLOSURES_URL = `${REPOSITORY_URL}#disclosures`;

/** The hero: the claim, its answer in the accent, the lede and the two routes into the product. */
export const HERO = {
  claim: 'Every company that hires an agent pays a team to wire it in.',
  answer: 'Day0 is onboarded instead.',
  lede: 'One name in. Day0 holds a five-minute one-to-one with its manager, drafts its own charter for approval, then does supervised work behind a gate that shows the exact action before anything reaches a surface.',
  tryDemo: 'Try the demo',
  setUp: 'Set up Day0',
} as const;

/** One card: a heading and the paragraph under it. */
export interface CopyCard {
  readonly title: string;
  readonly body: string;
}

/** The problem section: what happens now, and what Day0 does instead (v4 section 1.1, verbatim). */
export const PROBLEM = {
  heading: 'Today, deploying an agent means engineering one.',
  cards: [
    {
      title: 'What happens now',
      body: 'Someone defines the role, wires the tools, writes the prompts and encodes what counts as good work, and that work is done again for every team that wants one. Weeks per deployment.',
    },
    {
      title: 'What day0 does instead',
      body: 'Day0 is deployed with a name and nothing else. It reads the documentation you point it at, holds a Day-1 one-to-one with you, and drafts its own work charter (like a JD) for your approval. From there it works with you, with clear, distinct roles, and drives work autonomously under your supervision.',
    },
  ],
} as const satisfies { heading: string; cards: readonly CopyCard[] };

/** The positioning line and the four things every new hire gets. */
export const WHY = {
  heading: 'Onboarded, not engineered',
  lede: 'A generic agent becomes a bounded, auditable colleague through the four things every new hire gets.',
  items: [
    {
      title: 'Documentation',
      body: 'It reads what the team already wrote, from the sources the manager links.',
    },
    {
      title: 'A manager',
      body: 'Seven questions in one sitting. Every consequential step afterwards waits for that manager.',
    },
    {
      title: 'Permissions',
      body: 'Each system is asked for on its own card; every write is shown as the exact action and held until approved.',
    },
    {
      title: 'A charter',
      body: 'Drafted from the conversation, with the manager’s own sentence beside each rule, any of which can be struck.',
    },
  ],
} as const satisfies { heading: string; lede: string; items: readonly CopyCard[] };

/** The four how-it-works steps, in the order their frames are stacked. */
export const HOW = {
  heading: 'Four steps, and every one of them is a screen',
  steps: [
    {
      title: 'Reads the documentation',
      body: 'The manager links the team’s sources before the employee exists. Every page is synced and read as evidence, never as instructions. Nothing is guessed from a filename.',
    },
    {
      title: 'Holds a Day-1 one-to-one',
      body: 'Voice or chat, seven topics, one sitting. The manager’s answers come back verbatim as the charter’s evidence.',
    },
    {
      title: 'Drafts a charter the manager approves',
      body: 'Why this hire, the function, 30, 60 and 90 days, will do, will not do, and the rules derived from what the manager said. Strike any rule; approve when it reads right.',
    },
    {
      title: 'Works behind an exact-action gate',
      body: 'Every write is shown as the action it is, held for the manager, and recorded as landed, withheld or refused. Nothing reaches a surface first.',
    },
  ],
} as const satisfies { heading: string; steps: readonly CopyCard[] };

/** The two ways to try Day0 without connecting anything, and the closing ask. */
export const TRY = {
  heading: 'Try it without connecting anything',
  hosted: {
    title: 'The hosted mock office',
    body: 'Sign in, name an employee, hold the one-to-one yourself. The office is seeded and synthetic; nothing you do reaches a real system.',
    /** The disclosure sentence; its middle is a link to what the hosted demo sends and to whom. */
    notice: {
      before: 'Before you sign in, read ',
      link: 'what the hosted demo collects and who receives it',
      after: '.',
    },
  },
  local: {
    title: 'Run it on your own machine',
    body: 'Real mode against your own Slack and Linear, with any OpenAI-compatible model or a local one. Nothing leaves your machine unless you choose a hosted model.',
    commands: [
      'git clone https://github.com/BrianIsaac/day0.git',
      'cd day0',
      'pnpm install --frozen-lockfile',
      './setup.sh',
      'pnpm dev',
    ],
  },
  closingHeading: 'Give one employee a name',
  closingLede:
    'Try it on the hosted office, set it up on your own machine, or read the recorded run first.',
  readWalkthrough: 'Read the walkthrough',
} as const;

/** The footer: the disclosure and the three links. */
export const FOOTER = {
  disclosure:
    'Day0 is a working demonstration with no users and no production deployment. Figures are counts from single runs.',
  links: [
    { label: 'GitHub', href: REPOSITORY_URL },
    { label: 'Data and compliance', href: DISCLOSURES_URL },
    { label: 'Changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
  ],
} as const;
