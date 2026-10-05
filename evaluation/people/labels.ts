/*
 * V10's hand-labelled list (wave 13, 13-P; the wave file's section 11): every person the company
 * bed's pages name by their own name, with the page and the address its line gives. Labelled by
 * hand from `bed/company/folder/` as it stands; a role ("Messaging administrator"), a team, a
 * carrier or a customer is no person, and an employee placeholder is never named on a page.
 */

/** A person a bed page names. */
export interface LabelledPerson {
  /** The page's ref as a folder sync reads it. */
  readonly ref: string;
  readonly name: string;
  /** The address the page's line gives, when it gives one. */
  readonly email?: string;
}

/** The people the bed's pages name, in page order. */
export const PEOPLE_LABELS: readonly LabelledPerson[] = [
  { ref: 'onboarding.md', name: 'Lee Tan', email: 'lee.tan@kestrel.test' },
  { ref: 'onboarding.md', name: 'Noor Rahman', email: 'noor.rahman@kestrel.test' },
  { ref: 'onboarding.md', name: 'Rowan Hale', email: 'rowan.hale@kestrel.test' },
  { ref: 'onboarding.md', name: 'Femi Adeyemi', email: 'femi.adeyemi@kestrel.test' },
  { ref: 'onboarding.md', name: 'Dana Okafor', email: 'dana.okafor@kestrel.test' },
  { ref: 'finance/handbook.md', name: 'Ines Duarte', email: 'ines.duarte@kestrel.test' },
];
