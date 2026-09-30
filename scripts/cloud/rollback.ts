/**
 * The rollback a cloud run prints, filled in with what it read. It is a
 * runbook rather than a verb: undoing a production push is a decision,
 * taken with the release's changelog in hand.
 */
import { type CloudTarget } from './checkout';

/** What the rollback runbook is filled in with. */
export interface RollbackFacts {
  readonly target: CloudTarget;
  /** The app build that served production before this run, when there was one. */
  readonly previousApp?: string;
  /** The release the deployment was stamped at before, or undefined for a first push. */
  readonly previousRelease?: string;
  /** The export taken first, when one was. */
  readonly backup?: { readonly file: string; readonly sha256: string };
  /** The app's Convex values changed by this run, which a rollback puts back. */
  readonly appValuesChanged?: boolean;
}

/**
 * The rollback, written out with what the run read. Nothing in it is run for
 * the reader: undoing a production push is a decision, taken with the
 * release's changelog in hand.
 *
 * @param facts - What the run read.
 */
export function rollbackLines(facts: RollbackFacts): string[] {
  const { target } = facts;
  const scope = target.scope === undefined ? '' : ` --scope ${target.scope}`;
  const lines = ['Rollback (nothing here is run for you):'];
  lines.push(
    facts.previousApp === undefined
      ? '  the app: this run read no earlier production build to go back to.'
      : `  the app: vercel promote ${facts.previousApp}${scope}, the build that served production before this run.`,
  );
  if (facts.appValuesChanged) {
    lines.push(
      '  its Convex values: this run set NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL and ' +
        "CONVEX_DEPLOYMENT on Vercel production; put back what they held (printf '%s' <value> | " +
        `vercel env update <NAME> production --yes${scope}) before promoting the earlier build.`,
    );
  }
  if (facts.previousRelease === undefined) {
    lines.push(
      `  the deployment: ${target.deployment} held nothing before this run; an app that points away from it leaves it serving nobody.`,
    );
  } else if (facts.backup !== undefined) {
    lines.push(
      `  the rows and functions: ${facts.backup.file} (sha256 ${facts.backup.sha256}) holds the rows at ` +
        `v${facts.previousRelease}. From a clean checkout of v${facts.previousRelease}, take \`./setup.sh cloud backup\` ` +
        `of what you replace, then npx convex import --replace-all --deployment ${target.deployment} ` +
        `${facts.backup.file} and npx convex deploy --typecheck enable --env-file ${target.file}.`,
    );
  }
  return lines;
}
