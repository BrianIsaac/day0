/**
 * What a newcomer is told to type, and the facts that go around it.
 *
 * The same instructions are printed in three places that cannot see each other:
 * the `/setup` page, the English README and the Chinese one. Keeping the command
 * list here, and checking both README blocks against it in
 * `tests/src/setup/quickstart.test.ts`, is what stops one of the three drifting
 * into an instruction the other two do not give. `scripts/setup.ts` prints
 * `FIRST_SUCCESS` at the end of a run for the same reason: the page and the
 * terminal describe one first success, not two.
 *
 * Every figure in `MEASURED_TIMINGS` was measured; each one carries what it does
 * not include, because the part that decides how long a first run takes - the
 * container images and, on the account-free route, the weights - was not.
 */

/** The repository the quick start clones, and the page links as its source. */
export const REPOSITORY_URL = 'https://github.com/BrianIsaac/day0';

/** This guide, hosted, so the README can send a reader to the same page. */
export const SETUP_PAGE_URL = 'https://day0-olive.vercel.app/setup';

/** Everything a newcomer types, in order. */
export const QUICKSTART_COMMANDS: readonly string[] = [
  'git clone https://github.com/BrianIsaac/day0.git',
  'cd day0',
  'pnpm install --frozen-lockfile',
  'pnpm setup:local',
  'pnpm dev',
];

/** The commands as a fenced block, which is the form a README carries. */
export const QUICKSTART_BLOCK: string = ['```bash', ...QUICKSTART_COMMANDS, '```'].join('\n');

/**
 * The one-command entry at the repository root: real mode, on every route.
 * `pnpm setup:local` is the same script in mock mode, which the evaluation
 * harness and the hosted demo's workspace run on and which is not one of the
 * ways to run it.
 */
export const SETUP_SCRIPT = './setup.sh';

/**
 * The three ways to run it, as the deck's page 22, the README, the `/setup`
 * page, the setup's own text and `pnpm check:setup` name them. The two local
 * ways are real mode and differ in one thing only: where the model runs.
 */
export const WAY_NAMES = {
  hosted: 'Hosted demo',
  cloud: 'Local, cloud model',
  local: 'Local, local model',
} as const;

/** The routes `--route` takes, plus the checker's `none`. */
export type SetupRouteName = 'key' | 'local' | 'featherless' | 'endpoint' | 'none';

/**
 * Which way to run it a setup describes, for the checker's one line.
 *
 * Real mode on the bundled route is the local-model way and real mode on any
 * other route is the cloud-model way. Mock mode is neither: it is the seeded
 * office the evaluation harness and the hosted demo use.
 *
 * Args:
 *   mode: `DAY0_SURFACE_MODE`, or its default.
 *   route: The route the env file describes.
 *
 * Returns:
 *   The way's name, the mock-mode clause, or undefined when nothing applies.
 */
export function wayOfSetup(mode: string, route: SetupRouteName): string | undefined {
  if (mode === 'mock') return 'the seeded mock office, for the evaluation harness and the hosted demo';
  if (mode !== 'real' || route === 'none') return undefined;
  return route === 'local' ? WAY_NAMES.local : WAY_NAMES.cloud;
}

/** Where the hosted way goes; it has no commands. */
export interface RunWayLink {
  href: string;
  label: string;
}

/** A lifecycle verb of the real-mode entry, and what it keeps. */
export interface RunWayVerb {
  command: string;
  what: string;
}

/** One of the four ways to run it. */
export interface RunWay {
  id: 'hosted' | 'local' | 'key' | 'real';
  title: string;
  /** What it costs the reader and what it gives, before the commands. */
  body: string;
  /** The hosted way: the two pages it goes to. */
  links?: readonly RunWayLink[];
  /** The three local ways: what to type, in order, from an empty directory. */
  commands?: readonly string[];
  /** What the commands leave to say, after them. */
  after?: string;
  /** Real mode: stop for the day, come back, or throw it away. */
  verbs?: readonly RunWayVerb[];
}

/**
 * The four ways to run it, in the order they cost the reader: nothing
 * installed, nothing signed up for, one key, then your own systems. The deck
 * names the first three; the fourth is the same stack pointed at the reader's
 * own documentation and systems, which is the route the recorded run took.
 * Each carries a complete command list rather than a diff against the quick
 * start, because a reader arriving from the deck copies one block and runs it.
 * Every command here is checked against `package.json` and the repository root
 * in `tests/src/setup/quickstart.test.ts`.
 */
export const RUN_WAYS: readonly RunWay[] = [
  {
    id: 'hosted',
    title: 'Hosted demo',
    body: 'Nothing to install. Sign in and deploy an agent into the hosted mock office, which runs the product loop on synthetic content and reaches no system of yours; or open the walkthrough, a recording of one run that needs no sign-in at all.',
    links: [
      { href: '/sign-in', label: 'Sign in and deploy an agent' },
      { href: '/demo', label: 'Open the walkthrough' },
    ],
  },
  {
    id: 'local',
    title: 'Local, no account, and the model runs here',
    body: 'The five commands with the route named, so nothing is asked. The setup reads the free memory on your GPU, says which model it will pull and how large it is, and asks before it pulls; the model, the backend and the sandbox then run in Docker on this machine, and nothing is metered.',
    commands: [
      'git clone https://github.com/BrianIsaac/day0.git',
      'cd day0',
      'pnpm install --frozen-lockfile',
      'pnpm setup:local --route local',
      'pnpm dev',
    ],
    after:
      'How quickly it answers is a question about your hardware. --model <id> names a model instead of taking the one the setup chose, and --model-port moves the model server off 11434.',
  },
  {
    id: 'key',
    title: 'Local, with a key you already have',
    body: 'The same five commands with the other route named. The setup asks for the key in a hidden prompt and saves it in .env.local with owner-only permissions; nothing is downloaded beyond the container images, and there is no GPU question. Your chat and relevant synthetic office content are sent to the provider, which charges per token.',
    commands: [
      'git clone https://github.com/BrianIsaac/day0.git',
      'cd day0',
      'pnpm install --frozen-lockfile',
      'pnpm setup:local --route key',
      'pnpm dev',
    ],
    after:
      'The key route is OpenAI. For any other OpenAI-compatible provider, --route endpoint takes the address, and --route featherless writes the settings a hosted model through Featherless needs and asks for that key instead.',
  },
  {
    id: 'real',
    title: 'Real mode, on your own documentation and systems',
    body: 'The same backend and sandbox, pointed at a documentation folder you provide and the systems it records, plus a local span model that redacts credentials out of what is stored and a browser for systems that have no API. Local only by construction: a hosted deployment refuses this mode. One command from a clean clone, and one choice, where the model runs: a hosted model through Featherless, with a Featherless key asked for in a hidden prompt or read from FEATHERLESS_API_KEY, or the bundled model on this machine with --route local in place of --route featherless.',
    commands: [
      'git clone https://github.com/BrianIsaac/day0.git',
      'cd day0',
      'pnpm install --frozen-lockfile',
      './setup.sh --route featherless',
      'pnpm dev',
    ],
    after:
      'On the local route the setup lists the models before anything starts, first what its model volume already holds and then what this project has tested, each marked present with its size or will-pull with the download, and asks which to serve: a number on a terminal, --model <id> to name one, --yes for the default. A model already present is not pulled again. The redactor\'s first start on the CPU downloads about 251 MB of wheels and 1.16 GB of weights; --warm-from <project> copies another installation\'s volumes instead. First success differs here: link your documentation on the documentation page before you deploy, then hold the 1:1, approve the charter, and approve the connection cards on the Surfaces tab. The command prints those four when it finishes.',
    verbs: [
      {
        command: './setup.sh stop',
        what: 'containers down; the data, model and redactor volumes and .env.local are kept',
      },
      {
        command: './setup.sh resume',
        what: 'the same project, ports and admin key; nothing pulled again, and only changed values are re-synced',
      },
      {
        command: './setup.sh clear',
        what: 'containers, volumes and network removed; .env.local kept unless --purge-env; asks first unless --yes',
      },
    ],
  },
];

/** What the three verbs add up to, after the list of them. */
export const RUN_WAY_VERBS_NOTE =
  'Running the setup again is the same as resume, and --reset is clear followed by the setup.';

/** A tool the machine needs before any of it starts. */
export interface Prerequisite {
  /** The tool, and the version this project needs. */
  name: string;
  /** Why it is needed, and what the setup command says when it is missing. */
  detail: string;
  /** The command that gets it, where one line does the job. */
  fix?: string;
}

/** Checked by `pnpm setup:local` before it starts a single service. */
export const PREREQUISITES: readonly Prerequisite[] = [
  {
    name: 'Node 22 or newer',
    detail:
      'The version in package.json engines. The setup command reads it first and names the version it found.',
    fix: 'nvm install 22 && nvm use 22',
  },
  {
    name: 'pnpm 9 or newer',
    detail: 'If Corepack is installed, the command below downloads and activates pnpm. Otherwise install pnpm before continuing.',
    fix: 'corepack enable && corepack prepare pnpm@9 --activate',
  },
  {
    name: 'Docker, with Compose v2',
    detail:
      'The backend, the skill sandbox and, on the account-free route, the model server all run in containers. Compose v1 is not enough, and the setup command says so by name.',
  },
];

/** A host port this installation publishes, and what answers on it. */
export interface PublishedPort {
  port: number;
  what: string;
}

/** The default host ports, including services enabled only on optional routes. */
export const PUBLISHED_PORTS: readonly PublishedPort[] = [
  { port: 3210, what: 'the backend, which is where every row lives' },
  { port: 3211, what: 'the backend site proxy, used by its HTTP endpoints' },
  { port: 6791, what: 'the backend dashboard, only with the dev profile running' },
  { port: 3000, what: 'the app itself, which pnpm dev serves and the unlock URL names' },
  { port: 11434, what: 'the model server, on the account-free route only' },
];

/** One of the two ways a new installation reaches a model. */
export interface ModelRoute {
  id: 'key' | 'local';
  title: string;
  /** What the reader has to bring. */
  needs: string;
  /** What they get, and what it costs them. */
  gives: string;
  /** The flag that picks this route without being asked. */
  flag: string;
}

/**
 * The key route is offered first because it is shorter for anyone who already
 * holds a key; the account-free route is the one that signs up for nothing, and
 * it stays a first-class choice rather than a footnote.
 */
export const MODEL_ROUTES: readonly ModelRoute[] = [
  {
    id: 'key',
    title: 'A key you already have',
    needs:
      'An OpenAI API key. The setup command reads it in a hidden prompt and saves it in .env.local with owner-only permissions. Model requests send the key and prompt content to OpenAI. For another provider, use the advanced endpoint route below.',
    gives:
      'No model weights to download and no GPU requirement. Container images are still needed. The model runs at the provider, which charges per token.',
    flag: 'pnpm setup:local --route key',
  },
  {
    id: 'local',
    title: 'No account at all, and the model runs here',
    needs:
      'Room for one model. The setup command reads the free memory on your GPU, says which model it will pull and how large it is, and asks before it pulls anything.',
    gives:
      'The whole loop, skill creation included, with nothing signed up for and nothing metered. How quickly it answers is a question about your hardware.',
    flag: 'pnpm setup:local --route local',
  },
];

/** One thing the reader does once the setup command has finished. */
export interface FirstSuccessStep {
  /** What to do. */
  action: string;
  /** What it should look like, or what it proves. */
  detail: string;
}

/**
 * What a first success looks like. `scripts/setup.ts` prints these after its own
 * checker report, substituting the unlock URL it has just resolved into step one.
 */
export const FIRST_SUCCESS: readonly FirstSuccessStep[] = [
  {
    action: 'Open the unlock URL that pnpm dev prints.',
    detail:
      'It carries the key once; after that it is a cookie. Opening http://localhost:3000 directly answers 403, and that is the boundary working rather than a fault.',
  },
  {
    action: 'Deploy an agent.',
    detail:
      'The office it works in is seeded and synthetic. It does not connect to your work systems. On the key or remote-endpoint route, your chat and relevant office content are sent to the model provider.',
  },
  {
    action: 'Hold the Day-1 1:1 in chat mode and answer the seven topics.',
    detail:
      'It opens the conversation itself, and plain sentences are enough. Voice is greyed out unless you hold ElevenLabs credentials, which is expected: chat runs the identical seven-topic 1:1.',
  },
  {
    action: 'Approve the charter it writes.',
    detail: 'That is the first approval card, and approving it is what fills the work queue.',
  },
];

/** Something that has cost somebody an afternoon, and what to do instead. */
export interface SetupTrap {
  title: string;
  body: string;
}

/**
 * Both of the first two were found by running the setup command from a clean
 * clone rather than by reading it, and the third is the one prerequisite that is
 * a note rather than a stop.
 */
export const TRAPS: readonly SetupTrap[] = [
  {
    title: 'The two public addresses are written for you',
    body: 'The function push inside pnpm setup:local writes NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CONVEX_SITE_URL itself, and a self-hosted backend answers that question with its container ports rather than the ports your machine publishes. The setup command puts the host addresses back and says that it did. So do not set those two by hand: run pnpm setup:local again, which is idempotent, instead.',
  },
  {
    title: 'The admin key is generated, never pasted',
    body: 'The backend mints a new admin key every time it is asked, and every key it has ever minted for a volume goes on working, so a key moved between installations is a quiet way to talk to the wrong backend. pnpm setup:local writes CONVEX_SELF_HOSTED_ADMIN_KEY itself: it tries the key already in the file, keeps that one when this backend accepts it, and generates a key only when the file has none or this volume refuses the one it has.',
  },
  {
    title: 'Port 3000 is the app, and only a note',
    body: 'pnpm dev serves the app on 3000 and the unlock URL names that port, so anything already holding it takes the address the URL points at. The setup itself is unaffected, which is why pnpm setup:local reports it as a note rather than stopping; --app-port <n> moves the app, and the unlock URL with it.',
  },
];

/** A phase of a first run that was actually timed. */
export interface MeasuredTiming {
  /** The command or step. */
  phase: string;
  /** What it took. */
  measured: string;
  /** What that figure does not include. */
  excludes: string;
}

/**
 * Measured on one machine, from a clean clone with no environment copied into
 * it. They are what the parts of a first run cost when nothing has to be
 * downloaded, which is the half that can be measured honestly.
 */
export const MEASURED_TIMINGS: readonly MeasuredTiming[] = [
  {
    phase: 'git clone',
    measured: '0.3 s',
    excludes: 'from a repository on the same disk, so a clone over a network is not in this figure',
  },
  {
    phase: 'pnpm install --frozen-lockfile',
    measured: '2.7 s',
    excludes:
      'with a warm package store; a first install on a machine downloads the dependency set, which was not measured',
  },
  {
    phase: 'pnpm setup:local, first run',
    measured: '40.7 s',
    excludes: 'with both container images already present, so nothing at all was pulled',
  },
  {
    phase: 'pnpm setup:local, run again',
    measured: '38.3 s',
    excludes:
      'on the same installation, which it left exactly as it found it, down to the byte in .env.local',
  },
  {
    phase: 'pnpm dev, cold',
    measured: '5.8 s',
    excludes:
      'to the unlocked page answering, with the first compile included and the build cache deleted first',
  },
];

/** Why the figures above are not a promise about your machine. */
export const TIMING_CAVEAT =
  'Ten minutes is a target rather than a promise. Everything above was measured on a machine that already had both container images, and the download is the part that decides it: on linux/amd64 the backend image is about 207 MB to fetch and 578 MB once unpacked, the sandbox image about 46 MB and 127 MB, and the account-free route adds a model server image and 2.5 GB to 5 GB of weights on top. None of that was downloaded here, so none of it is in those figures.';

/** How to stop it, and what survives. */
export const STOP_AND_RESTART =
  'Stop it with pnpm sandbox:down && pnpm convex:down. Start it again with pnpm setup:local, which keeps what is already there: the same agent, the same rows, the same generated keys and settings. In real mode the same three things have names: ./setup.sh stop keeps every volume, ./setup.sh resume brings the same installation back, and ./setup.sh clear is the one that throws the volumes away.';

/** Where the rows live between runs. */
export const DATA_LOCATION =
  'Your data stays in the installation’s own Docker volume, named <project>_convex_data after the Compose project the setup command wrote into .env.local. Generated settings and keys live in .env.local beside the checkout. The helper also creates docs-local for the documentation mount; the sandbox uses <project>_sandbox_socket, the account-free route keeps model weights in <project>_model_data, and real mode adds <project>_redactor_venv and <project>_redactor_models for the redactor. Hosted model requests are processed by the selected provider.';

/** A README section worth reading once the quick start has worked. */
export interface DetailedSection {
  href: string;
  title: string;
  body: string;
}

/** The hand-run versions, which are what to read when something needs fixing. */
export const DETAILED_SECTIONS: readonly DetailedSection[] = [
  {
    href: `${REPOSITORY_URL}#local-dev`,
    title: 'Three ways to run it',
    body: 'What each route costs and what it gives you, including the hosted one this quick start leaves out.',
  },
  {
    href: `${REPOSITORY_URL}#run-it-with-no-accounts`,
    title: 'Run it with no accounts',
    body: 'What the account-free setup does, step by step: what each step is for and the trap it avoids.',
  },
  {
    href: `${REPOSITORY_URL}#run-it-with-an-openai-key`,
    title: 'Run it with a provider key',
    body: 'The same, for the shorter route, including why both model addresses stay empty on it.',
  },
  {
    href: `${REPOSITORY_URL}#run-it-in-real-mode`,
    title: 'Run it in real mode',
    body: 'Point it at your own documentation and your own systems. Local only, and deliberately unreachable from a hosted deployment.',
  },
  {
    href: `${REPOSITORY_URL}#environment`,
    title: 'Every environment variable',
    body: 'What each value in .env.local means, and which of them a route actually reads.',
  },
  {
    href: `${REPOSITORY_URL}#ports-host-side-and-container-side`,
    title: 'Ports, host side and container side',
    body: 'How to move the ports, and why an address means different things inside a container.',
  },
];
