/**
 * The owner's skill library, as pure rules (the enhancements plan, section 4.1; K1, K3, K4).
 *
 * A verified skill is a version in the owner's `skillVersions`; an employee's `skills` row is
 * what that employee holds. These are the rules the library's writers and readers share and
 * that need no database: how versions are numbered, which version may be offered to another
 * employee, the identity of a version's content, the words a "Re-check due" chip carries, which
 * authoring claim counts as an attempt, and the shared-skills switch.
 */
import { skillBodyHash } from './skill-body';

/** How many authoring attempts a skill has before the card stops offering Retry ("Attempt n of 3"). */
export const MAX_AUTHORING_ATTEMPTS = 3;

/**
 * The re-check reason the library backfill stamps on every holder of a version registered before
 * the passing smoke test was kept (K3): nothing can re-run its check until Re-check writes one.
 */
export const CHECK_NOT_KEPT_REASON = 'its check was not kept';

/**
 * The version number a new version of a name takes: one past the newest the owner holds, so
 * numbers only grow even after a version is deleted with its owner's data.
 *
 * @param versions - The numbers of the owner's versions of the name, in any order.
 */
export function nextVersionNumber(versions: readonly number[]): number {
  return versions.reduce((newest, version) => Math.max(newest, version), 0) + 1;
}

/**
 * The identity of a version's content: the body and the smoke test that passed with it.
 *
 * While the check is not kept the hash is the body's own, the same `sha256:` the execution claim
 * records on the ledger, so a backfilled version and the runs it served name one body. With a
 * smoke test the two are joined by a NUL, which neither a SKILL.md nor a Python source carries,
 * so no split of one text into the two hashes the same as another.
 *
 * @param body - SKILL.md as registered.
 * @param smokeTest - The smoke test that passed, or undefined when it was not kept.
 */
export function versionBodyHash(body: string, smokeTest: string | undefined): string {
  return skillBodyHash(smokeTest === undefined ? body : `${body}\u0000${smokeTest}`);
}

/** What decides a version's standing in the library. */
export interface VersionStandingFields {
  readonly smokeTest?: string;
  readonly revokedAt?: number;
  readonly supersededAt?: number;
}

/**
 * Where a version stands for an offer: `offerable`; withdrawn from every employee (`revoked`);
 * replaced by a newer version through Ask for a revision (`superseded`); or registered before
 * the passing check was kept (`check-not-kept`, K3).
 */
export type VersionStanding = 'offerable' | 'revoked' | 'superseded' | 'check-not-kept';

/**
 * A version's standing, the strongest first: a withdrawal outranks a supersession, and both
 * outrank a missing check.
 *
 * @param version - The version's smoke test and stamps.
 */
export function versionStanding(version: VersionStandingFields): VersionStanding {
  if (version.revokedAt !== undefined) return 'revoked';
  if (version.supersededAt !== undefined) return 'superseded';
  if (version.smokeTest === undefined) return 'check-not-kept';
  return 'offerable';
}

/**
 * Whether a version may be offered to another employee: its check is kept, and it is neither
 * withdrawn nor superseded.
 *
 * @param version - The version's smoke test and stamps.
 */
export function isOfferable(version: VersionStandingFields): boolean {
  return versionStanding(version) === 'offerable';
}

/**
 * The re-check reason a holder of an older version is stamped with when a newer version of the
 * same name registers: the employee keeps running the version it verified until it is re-checked.
 *
 * @param newer - The version that registered.
 * @param held - The version the holder runs.
 */
export function newerVersionReason(newer: number, held: number): string {
  return `v${newer} is verified; this runs v${held}`;
}

/** The shape `newerVersionReason` writes, and nothing else. */
const NEWER_VERSION_REASON = /^v\d+ is verified; this runs v\d+$/;

/**
 * Whether a re-check reason is the newer-version one, which names version numbers of the
 * library it was stamped in: a handover rewrites it, since the new owner's library numbers its
 * copies afresh.
 *
 * @param reason - A row's `recheckReason`.
 */
export function isNewerVersionReason(reason: string): boolean {
  return NEWER_VERSION_REASON.test(reason);
}

/**
 * The re-check reason a handed-over skill carries in place of one that named the old owner's
 * library: it was due a re-check, and still is.
 */
export const HANDED_OVER_RECHECK_REASON = 'it was due a re-check when the employee was handed over';

/**
 * The author a handed-over copy names when the moving employee did not write it: the colleague
 * who did stays with the previous manager, and the new manager's library does not name them.
 */
export const HANDED_OVER_AUTHOR_NAME = 'a colleague under the previous manager';

/**
 * The re-check reason a moved employee's skill is stamped with when the handover cut the
 * connection the skill acts on.
 *
 * @param slug - The cut surface's slug.
 */
export function surfaceCutReason(slug: string): string {
  return `its connection to ${slug} was cut when the employee was handed over`;
}

/** The values of `DAY0_SHARED_SKILLS` that switch sharing off; anything else leaves it on. */
const SHARED_SKILLS_OFF: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether skills are shared between an owner's employees (K4): on by default, the flag an off
 * switch, because every offer is a card the manager presses and every adoption is re-verified.
 *
 * @param raw - The deployment's `DAY0_SHARED_SKILLS`, unset when absent.
 */
export function sharedSkillsEnabled(raw: string | undefined): boolean {
  return !SHARED_SKILLS_OFF.has((raw ?? '').trim().toLowerCase());
}

/** What decides whether an authoring claim begins a new attempt. */
export interface AuthoringClaimFields {
  readonly state: string;
  readonly body: string;
  readonly authoringRunId?: string;
  readonly authoringDeferrals?: number;
  readonly pendingSmokeTest?: string;
}

/**
 * Whether an authoring claim on this row begins a new attempt ("Attempt n of 3").
 *
 * A claim carries on the attempt already counted when the row is mid-attempt: a provider outage's
 * own retry (`authoringDeferrals`), a takeover of a run that stopped holding a lease
 * (`authoringRunId` still set), or the check of a body already written whose sandbox never ran
 * (`pendingSmokeTest`). Every other claim writes a body, and is an attempt.
 *
 * @param row - The skill as the claim reads it.
 */
export function countsAsAuthoringAttempt(row: AuthoringClaimFields): boolean {
  if (row.state !== 'authoring') return true;
  if ((row.authoringDeferrals ?? 0) > 0) return false;
  if (row.authoringRunId !== undefined) return false;
  return !(row.pendingSmokeTest !== undefined && row.body !== '');
}

/** One connected surface of the smoke harness's contract, for the tools it allows. */
export interface HarnessSurfaceTools {
  readonly allowedTools: readonly string[];
}

/** One connected surface named by slug and class, for the tools it allows. */
export interface NamedHarnessSurface extends HarnessSurfaceTools {
  readonly slug: string;
  readonly surfaceClass?: string;
}

/** The tools a version needs on one surface (`harnessToolsBySurface`). */
export interface SurfaceTools {
  readonly slug: string;
  readonly surfaceClass?: string;
  readonly tools: string[];
}

/**
 * Whether SKILL.md names an operation as a whole word, as the smoke harness reads it: not inside
 * a longer identifier, and not as the head of a longer dotted name.
 */
function namesOperation(body: string, operation: string): boolean {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`).test(body);
}

/**
 * The tools a version needs (`harnessTools`): every tool the smoke harness's connected surfaces
 * allow that SKILL.md names, which is every tool the harness would let `run()` emit. An adopter
 * whose approved allowlist lacks one of them could not run the procedure.
 *
 * @param body - SKILL.md as registered.
 * @param surfaces - The harness contract's connected surfaces.
 * @returns The tools, once each, in allowlist order.
 */
export function harnessToolsNamed(
  body: string,
  surfaces: readonly HarnessSurfaceTools[],
): string[] {
  const tools = surfaces.flatMap((surface) => surface.allowedTools);
  return [...new Set(tools)].filter((tool) => namesOperation(body, tool));
}

/**
 * The tools a version needs, surface by surface: for each connected surface of the harness, the
 * tools it allows that SKILL.md names. An adopter's surface of the same class must allow the
 * tools listed for it (10-A's compatibility check); a surface SKILL.md names no tool of is left
 * out.
 *
 * @param body - SKILL.md as registered.
 * @param surfaces - The harness contract's connected surfaces, with their classes.
 * @returns One entry per surface that contributes a tool, in the order given.
 */
export function harnessToolsBySurface(
  body: string,
  surfaces: readonly NamedHarnessSurface[],
): SurfaceTools[] {
  return surfaces.flatMap((surface) => {
    const tools = harnessToolsNamed(body, [surface]);
    return tools.length === 0
      ? []
      : [
          {
            slug: surface.slug,
            ...(surface.surfaceClass !== undefined ? { surfaceClass: surface.surfaceClass } : {}),
            tools,
          },
        ];
  });
}
