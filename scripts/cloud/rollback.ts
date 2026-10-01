/**
 * The rollback a cloud run prints, filled in with what it read. It is a
 * runbook rather than a verb: undoing a production push is a decision,
 * taken with the release's changelog in hand.
 */
import { type CloudTarget } from './checkout';

/** The export an upgrade's rollback puts back. */
export interface RollbackExport {
  readonly file: string;
  readonly sha256: string;
  /** Taken when this upgrade first ran, before an attempt that stopped part way. */
  readonly earlier: boolean;
}

/** What the rollback runbook is filled in with. */
export interface RollbackFacts {
  readonly target: CloudTarget;
  /** The app build that served production before this run, when there was one. */
  readonly previousApp?: string;
  /** The app's Convex values changed by this run, which a rollback puts back. */
  readonly appValuesChanged?: boolean;
  /** An upgrade's release, the release before it when this run read it, and its export; absent for a first push. */
  readonly upgrade?: {
    readonly to: string;
    readonly from: string | undefined;
    readonly backup: RollbackExport;
  };
}

/**
 * The rollback, written out with what the run read: the steps to take, numbered in the order
 * they are taken (the deployment's rows and functions, or the app's Convex values, first, and the
 * earlier app build after them, so the build promoted back never meets the release it was not
 * built for), then what the run left with nothing to undo. Nothing in it is run for the reader:
 * undoing a production push is a decision, taken with the release's changelog in hand.
 *
 * @param facts - What the run read.
 */
export function rollbackLines(facts: RollbackFacts): string[] {
  const { target, upgrade } = facts;
  const scope = target.scope === undefined ? '' : ` --scope ${target.scope}`;
  const steps: string[] = [];
  const notes: string[] = [];
  if (upgrade !== undefined) steps.push(rowsStep(target, upgrade));
  if (facts.appValuesChanged) {
    // The promote it comes before is named only when the run read an earlier build to promote.
    const before = facts.previousApp === undefined ? '' : ' before promoting the earlier build';
    steps.push(
      'its Convex values: this run set NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL and ' +
        "CONVEX_DEPLOYMENT on Vercel production; put back what they held (printf '%s' <value> | " +
        `vercel env update <NAME> production --yes${scope})${before}.`,
    );
  }
  if (facts.previousApp === undefined) {
    notes.push('the app: this run read no earlier production build to go back to.');
  } else {
    const after = upgrade === undefined ? '' : ', after the import and the push';
    steps.push(
      `the app${after}: vercel promote ${facts.previousApp}${scope}, the build that served production before this run.`,
    );
  }
  if (upgrade === undefined) {
    notes.push(
      `the deployment: ${target.deployment} held nothing before this run; an app that points away from it leaves it serving nobody.`,
    );
  }
  return [
    `Rollback (nothing here is run for you)${steps.length > 1 ? ', in this order' : ''}:`,
    ...steps.map((step, at) => `  ${at + 1}. ${step}`),
    ...notes.map((note) => `  ${note}`),
  ];
}

/**
 * The step that puts an upgraded deployment's rows and functions back, run from the checkout of
 * the release the export's rows were written under.
 */
function rowsStep(target: CloudTarget, upgrade: NonNullable<RollbackFacts['upgrade']>): string {
  const { backup } = upgrade;
  const { taken, checkout } = exportOrigin(upgrade);
  return (
    `the rows and functions: ${backup.file} (sha256 ${backup.sha256}) holds the rows from before ` +
    `${taken}. From a clean checkout of ${checkout}, take \`./setup.sh cloud backup\` of what you ` +
    `replace, then npx convex import --replace-all --deployment ${target.deployment} ` +
    `${backup.file} and npx convex deploy --typecheck enable --env-file ${target.file}.`
  );
}

/** When an upgrade's export was taken, and where its rows are put back from. */
interface ExportOrigin {
  /** What the rows predate, read after "holds the rows from before". */
  readonly taken: string;
  /** The checkout to put them back from. */
  readonly checkout: string;
}

/**
 * When an upgrade's export was taken and the release its rows were written under: the release
 * the run read before it; this checkout's after a re-push of the release the deployment already
 * had; and an unread one when the export is an earlier attempt's, taken before the release first
 * reached the deployment.
 */
function exportOrigin(upgrade: NonNullable<RollbackFacts['upgrade']>): ExportOrigin {
  const { to, from, backup } = upgrade;
  if (backup.earlier) {
    return {
      taken: `the upgrade to v${to}, taken when that upgrade first ran`,
      checkout:
        from === undefined
          ? `the release the deployment ran before v${to} (this run did not read which)`
          : `v${from}`,
    };
  }
  if (from === undefined) {
    return { taken: `this run, which found v${to} already there`, checkout: `v${to} (this one)` };
  }
  return { taken: `the upgrade to v${to}`, checkout: `v${from}` };
}
