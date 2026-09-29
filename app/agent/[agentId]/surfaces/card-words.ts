import type { Doc } from '@convex/_generated/dataModel';
import type { SurfacePath } from '@/surfaces/types';
import { isSlackApiEndpoint } from '@/surfaces/slack-endpoint';
import { deploymentZone, expiryNoticeDue } from '@/lib/zone';
import type { Tone } from '../../../components/tone';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The verdicts of an approved card, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** Each rung of the ladder as the card names it, and how a system on it is reached. */
const RUNGS: Readonly<Record<SurfacePath, { readonly name: string; readonly via: string }>> = {
  mcp: { name: 'MCP', via: 'over MCP' },
  'documented-api': { name: 'API', via: 'over its API' },
  'browser-driven': { name: 'browser', via: 'in a browser' },
  escalate: { name: 'escalation', via: 'by escalation' },
};

/** A surface as the card's words read it. */
export type WordedSurface = Pick<
  Doc<'surfaces'>,
  'verdict' | 'path' | 'credentialLanded' | 'expiresAt' | 'reason' | 'endpoint' | 'displayName'
>;

/** Where a card's access stands against its end date. */
export type AccessStanding =
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly expiresAt: number }
  | { readonly kind: 'ending'; readonly expiresAt: number; readonly daysLeft: number }
  | { readonly kind: 'ended'; readonly expiresAt: number };

/**
 * Where a card's access stands: not started (the card is not approved), running, ending (from
 * the day the server's week notice is due, in the employee's zone, so the card and the notice
 * never disagree by a day), or ended. A passed date is ended whatever the hourly sweep has
 * marked, and so is a card the sweep marked `expired` (K finding 5).
 *
 * @param surface - The card's row.
 * @param now - The instant to judge against.
 * @param zone - The employee's zone; the deployment's when the page has none.
 */
export function accessStanding(
  surface: Pick<WordedSurface, 'verdict' | 'expiresAt' | 'reason'>,
  now: number,
  zone: string | undefined,
): AccessStanding {
  if (!ACCESS_VERDICTS.has(surface.verdict) || surface.expiresAt === undefined) {
    return { kind: 'none' };
  }
  const { expiresAt } = surface;
  if (surface.reason === 'expired' || expiresAt <= now) return { kind: 'ended', expiresAt };
  if (expiryNoticeDue(now, expiresAt, zone ?? deploymentZone())) {
    return { kind: 'ending', expiresAt, daysLeft: Math.ceil((expiresAt - now) / DAY_MS) };
  }
  return { kind: 'running', expiresAt };
}

/** The rung a path names, or nothing for a card with no path yet. */
function rungOf(path: string | undefined): (typeof RUNGS)[SurfacePath] | undefined {
  return path !== undefined && Object.hasOwn(RUNGS, path) ? RUNGS[path as SurfacePath] : undefined;
}

/**
 * How a system on this path is reached, in the card's words: "over MCP", "in a browser".
 *
 * @param path - The card's approved or proposed path.
 */
export function reachedWords(path: string | undefined): string | undefined {
  return rungOf(path)?.via;
}

/** A card's state chip: its words and its tone. */
export interface StateChipWords {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * The state chip a card carries, in the manager's words: what the card is waiting for or what it
 * can do, never the stored verdict. Access that has ended or ends within the week outranks the
 * connection, since it is what the manager has to act on.
 *
 * @param surface - The card's row.
 * @param now - The instant to judge the access against.
 */
export function stateChip(
  surface: WordedSurface,
  now: number,
  zone: string | undefined,
): StateChipWords {
  const access = accessStanding(surface, now, zone);
  if (access.kind === 'ended') return { text: 'Access ended', tone: 'warn' };
  if (access.kind === 'ending') {
    return {
      text: `Expires in ${access.daysLeft} ${access.daysLeft === 1 ? 'day' : 'days'}`,
      tone: 'warn',
    };
  }
  const rung = rungOf(surface.path);
  switch (surface.verdict) {
    case 'declared':
      return { text: 'No proposal yet', tone: 'muted' };
    case 'proposed':
      return { text: rung ? `Proposed · ${rung.name}` : 'Proposed', tone: 'muted' };
    case 'approved':
      return surface.credentialLanded
        ? { text: 'Checking the connection', tone: 'accent' }
        : { text: 'Needs its credential', tone: 'warn' };
    case 'connected':
      return { text: rung ? `Connected ${rung.via}` : 'Connected', tone: 'ok' };
    case 'ungranted':
      return { text: 'Not granted', tone: 'warn' };
    case 'listed-dead':
      return { text: 'Not answering', tone: 'warn' };
    case 'absent':
      return { text: 'Not found', tone: 'muted' };
  }
}

/** What a card's credential field asks for: its label and the line under it. */
export interface ExpectedCredential {
  /** Whose credential the field takes, as its label says it. */
  readonly label: string;
  /** What happens to it, or what is refused. */
  readonly hint: string;
}

/**
 * Whose credential a card's field expects (Q10): the Slack app's bot token, the sign-in a browser
 * session types, or the credential the documentation names. The Slack line is the rule the
 * server's landing refusal enforces (`credentialLandingRefusal`).
 *
 * @param surface - The card's row.
 * @param documented - The credential's name as the documentation gives it, when it gives one.
 */
export function expectedCredential(
  surface: Pick<WordedSurface, 'path' | 'endpoint' | 'displayName'>,
  documented: string | undefined,
): ExpectedCredential {
  if (isSlackApiEndpoint(surface.endpoint)) {
    return {
      label: "The Slack app's bot token, the one that begins xoxb-",
      hint: 'A user token would post as that person, so Slack takes only the bot token here. It is stored encrypted and never shown again.',
    };
  }
  if (surface.path === 'browser-driven') {
    return {
      label: `The ${documented ?? `${surface.displayName} sign-in`} the browser session signs in with`,
      hint: "The browser session types it only into the sign-in form's credential field. It is stored encrypted and never shown again.",
    };
  }
  return {
    label: documented
      ? `The ${documented} the documentation names`
      : `A ${surface.displayName} credential with the documented permissions`,
    hint: 'It is stored encrypted and never shown again.',
  };
}
