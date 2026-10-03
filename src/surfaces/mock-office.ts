/**
 * The hosted mock office as every screen names it: its systems, in the order the office draws
 * them, and whom an employee acts as in them. The Surfaces tab and the Record's "What it knows"
 * both read these, so the two say one thing (round 0141 R-D item 3).
 */

/** The office's systems, one tab each on the Surfaces tab, keyed by the tab that shows each. */
export const MOCK_OFFICE_SYSTEMS = [
  { key: 'slack', label: 'Slack' },
  { key: 'spreadsheet', label: 'Spreadsheet' },
  { key: 'docs', label: 'Docs' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'tweet', label: 'Social' },
] as const;

/**
 * The office's "Acts as" words, the same on every one of its systems: in mock mode nothing leaves
 * the office, and the employee is the office's own app in each of them.
 *
 * @param employee - The employee's name.
 */
export function mockActsAsWords(employee: string): string {
  return `${employee}, its own app in this office`;
}

/**
 * The office's systems as a phrase: "Slack, Spreadsheet, Docs, Tickets and Social".
 */
export function mockOfficeSystemsPhrase(): string {
  const labels = MOCK_OFFICE_SYSTEMS.map((system) => system.label);
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
