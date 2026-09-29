/**
 * The browser job's known-debt rule, kept apart from Playwright so it can be tested on its own.
 *
 * A finding is keyed by what failed and where: an axe violation as `rule selector` for one node,
 * a small pointer target as `tag "name" at selector`. A debt covers a finding only when it names
 * that key, so a second node of a known rule, or a second control of a known name, still fails. A
 * debt the page no longer carries is reported too, so each entry leaves with its fix.
 */

/** The two viewports the Playwright projects set; a debt can belong to one of them. */
export type Project = 'desktop' | 'phone';

/** A failure a public page carries today, named node by node. */
export interface Debt {
  /** Why it is not fixed yet, and whose file it is. */
  readonly reason: string;
  /** The project it shows under; both when absent. */
  readonly project?: Project;
  /** The axe findings it covers, each as `rule selector` for one node. */
  readonly axe?: readonly string[];
  /** The controls under 44 px it covers, each as `tag "name" at selector`. */
  readonly targets?: readonly string[];
}

/** One key a debt covers, with the debt's reason. */
export interface DebtKey {
  readonly key: string;
  readonly reason: string;
}

/**
 * The keys a page's debts cover under one project.
 *
 * @param debts - The page's debts.
 * @param project - The Playwright project running.
 * @param kind - Which list: axe findings or small targets.
 */
export function debtKeys(
  debts: readonly Debt[],
  project: string,
  kind: 'axe' | 'targets',
): DebtKey[] {
  return debts
    .filter((debt) => debt.project === undefined || debt.project === project)
    .flatMap((debt) => (debt[kind] ?? []).map((key) => ({ key, reason: debt.reason })));
}

/**
 * The findings no debt covers.
 *
 * @param known - The keys the page's debts cover.
 * @param found - Each finding's key.
 */
export function beyondDebt(known: readonly DebtKey[], found: readonly string[]): string[] {
  return found.filter((finding) => !known.some((debt) => debt.key === finding));
}

/**
 * The debt keys no finding meets: debt the page no longer carries.
 *
 * @param known - The keys the page's debts cover.
 * @param found - Each finding's key.
 */
export function unmetDebt(known: readonly DebtKey[], found: readonly string[]): string[] {
  return known.map((debt) => debt.key).filter((key) => !found.includes(key));
}
