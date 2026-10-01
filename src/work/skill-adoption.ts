/**
 * Adoption, as pure rules (the enhancements plan, section 4.1; A3; 10-A).
 *
 * At `needs-skill` an employee may be offered a sibling's verified skill instead of writing its
 * own: the owner's newest version of the shape that is offerable, written by another employee,
 * and that fits the adopter. These are the rules that need no database: whether a version fits
 * the adopter's own contract (a connected surface of the class, every tool it names inside that
 * surface's approved allowlist, the system in the charter), which version is offered, the scopes
 * the adopter would gain, the card's state as the row says it, and the card's words. The sandbox
 * re-verifies the version under the adopter's own connection before it runs; nothing here
 * replaces that check, it only decides what is worth offering.
 */
import type { Doc } from '../../convex/_generated/dataModel';
import type { SurfaceMode } from '../lib/surface-mode';
import { AUTHORING_LEASE_MS } from '../lib/skill-authoring';
import { zonedParts } from '../lib/zone';
import { HANDED_OVER_AUTHOR_NAME, isOfferable, type VersionStandingFields } from './skill-library';

/** One of the adopter's surfaces, as the compatibility check reads it. */
export interface AdopterSurface {
  readonly slug: string;
  /** The name the card says the connection by. */
  readonly displayName: string;
  readonly class: string;
  /** Whether the surface is connected now, by its live verdict. */
  readonly connected: boolean;
  /** The tools the manager approved on it (`approvedToolAllowlist`); empty when none. */
  readonly approvedTools: readonly string[];
  /** Whether it carries current charter evidence (`discoveryEvidence` of kind `charter`). */
  readonly charterEvidence: boolean;
}

/** The employee a version would be adopted for, as the compatibility check reads it. */
export interface Adopter {
  readonly agentId: string;
  readonly mode: SurfaceMode;
  /** The employee's surfaces; the mock office has none. */
  readonly surfaces: readonly AdopterSurface[];
  /** The classes of the systems the employee's approved charter names (`namedSystems`). */
  readonly charterClasses: readonly string[];
}

/** The tools a version needs on one surface, as the library keeps them. */
export interface VersionSurfaceTools {
  readonly slug: string;
  readonly surfaceClass?: string;
  readonly tools: readonly string[];
}

/** A version of the owner's library, as an offer reads it. */
export interface AdoptableVersion extends VersionStandingFields {
  readonly name: string;
  readonly surfaceClass: string;
  readonly harnessTools: readonly string[];
  readonly harnessToolsBySurface?: readonly VersionSurfaceTools[];
  /** The employee who wrote it; absent once that employee left the owner. */
  readonly authorAgentId?: string;
}

/** Why a version does not fit an adopter. */
export type AdoptionMismatch = 'no-connected-surface' | 'tool-not-approved' | 'no-charter-evidence';

/** Whether a version fits an adopter, and the connection it would be re-verified under. */
export type AdoptionFit =
  | { readonly fits: true; readonly connection?: AdopterSurface }
  | { readonly fits: false; readonly mismatch: AdoptionMismatch; readonly detail: string };

/** A mismatch, with the clause the refusal and the record say it in. */
function mismatch(kind: AdoptionMismatch, detail: string): AdoptionFit {
  return { fits: false, mismatch: kind, detail };
}

/**
 * The surfaces of the adopter an entry of the version's tools names: those of its class, or the
 * one of its slug when the version kept no class for it.
 */
function surfacesFor(
  entry: VersionSurfaceTools,
  connected: readonly AdopterSurface[],
): readonly AdopterSurface[] {
  return entry.surfaceClass !== undefined
    ? connected.filter((surface) => surface.class === entry.surfaceClass)
    : connected.filter((surface) => surface.slug === entry.slug);
}

/** The first tool of an entry a surface's approved allowlist lacks, or undefined when none. */
function firstUnapproved(entry: VersionSurfaceTools, surface: AdopterSurface): string | undefined {
  return entry.tools.find((tool) => !surface.approvedTools.includes(tool));
}

/**
 * The version's tools, surface by surface. A version that kept no per-surface list (registered
 * before 10-K kept one) names its flat list against a surface of its own class.
 */
function toolEntries(version: AdoptableVersion): readonly VersionSurfaceTools[] {
  if (version.harnessToolsBySurface !== undefined) return version.harnessToolsBySurface;
  if (version.harnessTools.length === 0) return [];
  return [
    { slug: version.surfaceClass, surfaceClass: version.surfaceClass, tools: version.harnessTools },
  ];
}

/**
 * Whether a version fits the adopter's own contract (A3: re-verified under the adopter's
 * connection and tool allowlist), checked in this order:
 *
 * 1. a connected surface of the version's class;
 * 2. for every surface the version names tools on, a connected surface of that class (or, with
 *    no class kept, of that slug) whose approved allowlist holds every one of those tools;
 * 3. charter evidence for the system: the approved charter names a system of the class, or the
 *    class's surface carries current charter evidence, so a skill is never adopted onto a system
 *    the manager did not put in this employee's charter.
 *
 * In mock mode the mock office stands in for every connection and allowlist, as it does for an
 * approval, and only the charter is asked.
 *
 * @param version - The version as the library keeps it.
 * @param adopter - The employee it would be adopted for.
 * @returns The fit, with the adopter's surface of the class the sandbox would run under.
 */
export function adoptionFit(version: AdoptableVersion, adopter: Adopter): AdoptionFit {
  const { surfaceClass } = version;
  if (adopter.mode === 'mock') {
    return adopter.charterClasses.includes(surfaceClass)
      ? { fits: true }
      : mismatch('no-charter-evidence', `the charter names no ${surfaceClass} system`);
  }
  const connected = adopter.surfaces.filter((surface) => surface.connected);
  const ofClass = connected.filter((surface) => surface.class === surfaceClass);
  if (ofClass.length === 0) {
    return mismatch('no-connected-surface', `there is no connected ${surfaceClass} surface`);
  }
  for (const entry of toolEntries(version)) {
    const candidates = surfacesFor(entry, connected);
    if (candidates.length === 0) {
      return mismatch(
        'no-connected-surface',
        entry.surfaceClass !== undefined
          ? `there is no connected ${entry.surfaceClass} surface`
          : `there is no connected surface ${entry.slug}`,
      );
    }
    if (candidates.every((surface) => firstUnapproved(entry, surface) !== undefined)) {
      const [first] = candidates;
      return mismatch(
        'tool-not-approved',
        `the approved tools of ${first.displayName} do not include ${firstUnapproved(entry, first)}`,
      );
    }
  }
  const chartered =
    adopter.charterClasses.includes(surfaceClass) ||
    ofClass.some((surface) => surface.charterEvidence);
  if (!chartered) {
    return mismatch('no-charter-evidence', `the charter names no ${surfaceClass} system`);
  }
  const allowing = toolEntries(version).find((entry) => entry.surfaceClass === surfaceClass);
  const connection =
    allowing === undefined
      ? ofClass[0]
      : (ofClass.find((surface) => firstUnapproved(allowing, surface) === undefined) ?? ofClass[0]);
  return { fits: true, connection };
}

/**
 * Whether a version may be offered to the adopter at all, before its fit is asked: its check is
 * kept, it is neither withdrawn nor superseded, and another employee wrote it. A version whose
 * author has left the owner (no `authorAgentId`) was written by someone else too.
 *
 * @param version - The version as the library keeps it.
 * @param adopter - The employee it would be offered to.
 */
export function isOfferedTo(version: AdoptableVersion, adopter: Pick<Adopter, 'agentId'>): boolean {
  return isOfferable(version) && version.authorAgentId !== adopter.agentId;
}

/**
 * The version an adopter is offered for a skill name: the newest, of the owner's versions given
 * newest first, that is of the name, may be offered to the adopter and fits it.
 *
 * @param versions - The owner's versions of the shape, newest first.
 * @param name - The skill name the proposal carries (`<class>-<operation>`).
 * @param adopter - The employee it would be offered to.
 * @returns The version, or undefined when none passes.
 */
export function chooseOffer<Version extends AdoptableVersion>(
  versions: readonly Version[],
  name: string,
  adopter: Adopter,
): Version | undefined {
  return versions.find(
    (version) =>
      version.name === name && isOfferedTo(version, adopter) && adoptionFit(version, adopter).fits,
  );
}

/**
 * The scopes an adoption would grant: the ones the proposal needs that the adopter holds no live
 * grant for, once each, in the proposal's order. Execution authority stays the adopter's own
 * grants, so this is all an adoption may add.
 *
 * @param required - The proposal's required scopes, for the adopter's own surfaces.
 * @param granted - The adopter's live grants.
 */
export function missingScopes(
  required: readonly string[] | undefined,
  granted: Iterable<string>,
): string[] {
  const held = new Set(granted);
  return [...new Set(required ?? [])].filter((scope) => !held.has(scope));
}

/**
 * The states the adoption card draws: offered; verifying while a run checks it; stalled when the
 * check stopped short (parked for want of a sandbox, a run that lapsed, or a refusal before it
 * ran) and nothing holds it; failed; and declined.
 */
export const ADOPTION_CARD_STATES = [
  'offered',
  'verifying',
  'stalled',
  'failed',
  'declined',
] as const;

/** One of {@link ADOPTION_CARD_STATES}. */
export type AdoptionCardState = (typeof ADOPTION_CARD_STATES)[number];

/** What decides a row's adoption card. */
export interface AdoptionRowFields {
  readonly state: Doc<'skills'>['state'];
  readonly offeredVersionId?: string;
}

/**
 * The card a row with an offer draws, as its state says: a proposal is offered; a row approved
 * to adopt, or held by the stored verification, is verifying; a failed one has failed. A row
 * with no offer, or whose offer was answered by registration or a decision, draws none. Declined
 * is the card's own state after the manager's Decline, which the row no longer lists.
 *
 * @param row - The holder row.
 */
export function adoptionCardState(
  row: AdoptionRowFields,
): 'offered' | 'verifying' | 'failed' | undefined {
  if (row.offeredVersionId === undefined) return undefined;
  switch (row.state) {
    case 'proposed':
      return 'offered';
    case 'approved':
    case 'authoring':
    case 'verified':
      return 'verifying';
    case 'failed':
      return 'failed';
    case 'registered':
    case 'rejected':
    case 'retired':
    case 'superseded':
      return undefined;
    default: {
      const unknown: never = row.state;
      throw new Error(`unhandled skill state ${String(unknown)}`);
    }
  }
}

/** What decides whether a verifying adoption is still being checked. */
export interface AdoptionAtFields {
  readonly state: 'offered' | 'verifying' | 'failed';
  readonly rowState: Doc<'skills'>['state'];
  /** When the run holding the row claimed it; absent when no run holds it. */
  readonly claimedAt?: number;
  /** Why the offer no longer stands, when it does not. */
  readonly refusal?: string;
}

/**
 * The card an adoption draws at a moment: a verifying one is still verifying while a live run
 * holds it, or while it is approved and its scheduled check has not claimed it yet (unless the
 * offer no longer stands, so the check will refuse); otherwise it stalled, and the card offers
 * Check it again. Read against the browser's clock, so a run that lapses is seen to.
 *
 * @param adoption - The adoption as the backend draws it.
 * @param now - The clock.
 */
export function adoptionStateAt(adoption: AdoptionAtFields, now: number): AdoptionCardState {
  if (adoption.state !== 'verifying') return adoption.state;
  // The claim's own lease (`holdsLiveAuthoringClaim`): a run past it is gone.
  const live = adoption.claimedAt !== undefined && now - adoption.claimedAt < AUTHORING_LEASE_MS;
  if (live) return 'verifying';
  return adoption.rowState === 'approved' && adoption.refusal === undefined
    ? 'verifying'
    : 'stalled';
}

/** How `skillActions.verifyStoredSkill` words a parked check on the row, around its reason. */
const PARKED_CHECK = /^the stored skill was not verified: (.+?)(?:; Retry runs its check)?$/s;

/**
 * Why an adoption's check stopped short, from the row's log: the reason of a parked check without
 * the words that point at the Not callable card's Retry (the adoption card's control is Check it
 * again), or the log as it is.
 *
 * @param log - The row's `verificationLog`.
 */
export function stalledReason(log: string | undefined): string | undefined {
  if (log === undefined) return undefined;
  return PARKED_CHECK.exec(log.trim())?.[1] ?? log.trim();
}

/** The month names the card prints a day with. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The day a version was verified, as the card prints it: `18 September 2026`. Built from the
 * zone's parts, as every stamp is, so the backend and every browser print the same text.
 *
 * @param ms - When the version was verified.
 * @param zone - The adopter's zone.
 */
export function verifiedOnDay(ms: number, zone: string): string {
  const { year, month, day } = zonedParts(ms, zone);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** What the card's words are made from. */
export interface AdoptionWordsInput {
  readonly state: AdoptionCardState;
  readonly adopterName: string;
  /** The version's `authorName`; {@link HANDED_OVER_AUTHOR_NAME} for a handed-over copy. */
  readonly authorName: string;
  readonly skillName: string;
  /** {@link verifiedOnDay} of the version. */
  readonly verifiedOn: string;
  /** The adopter's connection the sandbox runs under, by name; absent in mock mode. */
  readonly connection?: string;
}

/** The card's sentences. */
export interface AdoptionWords {
  /** The first sentence, set apart: whose skill, and where it stands. */
  readonly lead: string;
  /** What it means for the adopter. */
  readonly body: string;
  /** The words before the scopes the adoption would grant. */
  readonly scopesLead: string;
  /** Said in place of the scopes when the adopter holds every one. */
  readonly noScopes: string;
}

/**
 * The card's words, wording drafts (a product call). A copy handed over from another manager is
 * said as its own case, since its author's name is the placeholder 10-K writes for a colleague
 * this manager never had.
 *
 * @param input - The state, the people, the skill and the connection.
 */
export function adoptionWords(input: AdoptionWordsInput): AdoptionWords {
  const { adopterName, skillName, verifiedOn } = input;
  const handedOver = input.authorName === HANDED_OVER_AUTHOR_NAME;
  const skill = handedOver ? `the skill ${skillName}` : `${input.authorName}'s skill ${skillName}`;
  const opening = handedOver ? `The skill ${skillName}` : skill;
  const under =
    input.connection !== undefined ? ` under ${adopterName}'s ${input.connection} connection` : '';
  const scopes = {
    scopesLead: `Scopes ${adopterName} would gain`,
    noScopes: `${adopterName} already holds every scope the skill needs.`,
  };
  switch (input.state) {
    case 'offered':
      return {
        lead: handedOver
          ? `${opening}, which came with an employee handed over to you and was verified on ${verifiedOn}, does this.`
          : `${opening}, verified on ${verifiedOn}, does this.`,
        body: `${adopterName} can adopt it. It would be re-verified in the sandbox${under} before ${adopterName} can use it.`,
        ...scopes,
      };
    case 'verifying':
      return {
        lead: `Adopting ${skill} for ${adopterName}.`,
        body: `It is being re-verified in the sandbox${under}. ${adopterName} can use it once the check passes; there is nothing to press until then.`,
        ...scopes,
      };
    case 'stalled':
      return {
        lead: `Adopting ${skill} for ${adopterName} stopped before the sandbox finished checking it.`,
        body: `${adopterName} cannot use it yet. Check it again, write a new one instead, or decline it.`,
        ...scopes,
      };
    case 'failed':
      return {
        lead: `${opening} failed its re-verification for ${adopterName}.`,
        body: `${adopterName} cannot use it, and keeps the scopes the adoption granted. Write a new one instead to have ${adopterName} write and verify a new one, or decline it.`,
        ...scopes,
      };
    case 'declined':
      return {
        lead: `You declined ${skill} for ${adopterName}.`,
        body: `${adopterName} will not adopt it, and the work waiting for it was cancelled.`,
        ...scopes,
      };
  }
}

/**
 * The note under the proposals: what approving does, said for either way when a card offers an
 * adoption (the prototype's "Approving either way").
 *
 * @param adopterName - The employee.
 * @param offersAdoption - Whether any proposal on the card offers an adoption.
 */
export function adoptionHelp(adopterName: string, offersAdoption: boolean): string {
  const charter = `Whether that work is within ${adopterName}'s charter is judged separately.`;
  return offersAdoption
    ? `Either way the skill is checked in a sandbox before it runs, then the item that needs it is evaluated again. ${charter}`
    : `Approving writes the skill and checks it in a sandbox, then evaluates again the item that needs it. ${charter}`;
}
