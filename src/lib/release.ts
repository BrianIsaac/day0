/**
 * The release facts the code carries, as distinct from the ones a checkout's
 * `package.json` and `CHANGELOG.md` record: the newest release any shipped
 * migration names, and how two releases compare.
 *
 * `convex/migrations.ts` refuses to stamp a release older than the newest its
 * migrations name (S D8), and `scripts/releases.ts` refuses to push a checkout
 * whose own release is older than it, before anything on the deployment
 * changes: a staging tree before its release commit would otherwise run every
 * migration and then be refused the stamp, leaving a fresh volume that reads
 * as unstamped rows on every later run (wave 3.5 review M4).
 */

/**
 * The newest release any shipped migration names. Bumped in the commit that
 * ships the first migration of a release; `tests/convex/migrations.test.ts`
 * holds it equal to the migrations' own releases.
 */
export const NEWEST_MIGRATION_RELEASE = '0.14.0';

/** A release as a stamp names it: three dot-separated numbers, no prefix. */
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A release's three numbers, or undefined when it is not shaped as one. */
export function releaseParts(release: string): readonly [number, number, number] | undefined {
  const match = RELEASE.exec(release);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Negative when `older` precedes `newer`, zero when they are the same
 * release, positive when `older` is in fact the newer of the two.
 *
 * @throws Error when either is not shaped as a release.
 */
export function compareReleases(older: string, newer: string): number {
  const a = releaseParts(older);
  const b = releaseParts(newer);
  if (a === undefined) throw new Error(`${older} is not a release shaped as X.Y.Z`);
  if (b === undefined) throw new Error(`${newer} is not a release shaped as X.Y.Z`);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
