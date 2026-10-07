import { normaliseManagerAddress } from '../../src/agent/manager-address';
import { personNameKey } from '../../src/people/vocabulary';
import type { LabelledPerson } from './labels';

/*
 * V10, the people extraction's precision (wave 13, 13-P; the wave file's section 11; the
 * gate-matrix pattern of `evaluation/gate/`): the people a run extracted from the bed's pages,
 * read from the employee's exported trace, graded against the hand-labelled list. A person is
 * found when the same page names them, by name or by the address the page gave (a page's person
 * merged into one already known keeps that person's name). Pure; `run.ts` writes the evidence.
 */

/** A person a run extracted from one page. */
export interface ExtractedPerson {
  readonly ref: string;
  readonly name: string;
  readonly email?: string;
}

/** How the addresses of the people found compare with the labels. */
export interface AddressCounts {
  readonly correct: number;
  readonly wrong: number;
  readonly missing: number;
}

/** One grade of one run: the counts, the rates and every miss. */
export interface PeopleGrade {
  readonly schemaVersion: 1;
  readonly experiment: 'day0-people-extraction';
  readonly generatedAt: string;
  readonly commit: string;
  readonly labelled: number;
  readonly extracted: number;
  readonly truePositives: number;
  /** Null when there is nothing to divide by. */
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly addresses: AddressCounts;
  readonly falsePositives: readonly ExtractedPerson[];
  readonly falseNegatives: readonly LabelledPerson[];
}

/** Whether an extracted person is a labelled one: the same page, and the same name or address. */
function samePerson(label: LabelledPerson, found: ExtractedPerson): boolean {
  if (label.ref !== found.ref) return false;
  if (personNameKey(label.name) === personNameKey(found.name)) return true;
  const address = normaliseManagerAddress(label.email);
  return address !== undefined && address === normaliseManagerAddress(found.email);
}

/** A rate, or null with nothing to divide by. */
function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/**
 * Grade a run's extracted people against the labels.
 *
 * @param labels - The hand-labelled people.
 * @param extracted - The people the run extracted, one per page each was quoted on.
 * @param commit - The commit the run was made at.
 * @param now - When the grade is taken.
 */
export function gradeExtraction(
  labels: readonly LabelledPerson[],
  extracted: readonly ExtractedPerson[],
  commit: string,
  now: Date,
): PeopleGrade {
  const matched = new Set<LabelledPerson>();
  const falsePositives: ExtractedPerson[] = [];
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  for (const found of extracted) {
    const label = labels.find(
      (candidate) => !matched.has(candidate) && samePerson(candidate, found),
    );
    if (label === undefined) {
      falsePositives.push(found);
      continue;
    }
    matched.add(label);
    const wanted = normaliseManagerAddress(label.email);
    const given = normaliseManagerAddress(found.email);
    if (wanted === undefined) continue;
    if (given === undefined) missing += 1;
    else if (given === wanted) correct += 1;
    else wrong += 1;
  }
  const truePositives = matched.size;
  const precision = rate(truePositives, extracted.length);
  const recall = rate(truePositives, labels.length);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    schemaVersion: 1,
    experiment: 'day0-people-extraction',
    generatedAt: now.toISOString(),
    commit,
    labelled: labels.length,
    extracted: extracted.length,
    truePositives,
    precision,
    recall,
    f1,
    addresses: { correct, wrong, missing },
    falsePositives,
    falseNegatives: labels.filter((label) => !matched.has(label)),
  };
}

/** A value as an object, or undefined. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The people documentation quoted, one per page each was quoted on, from the people table's rows:
 * a person proposed from the pages, and one a page's words were merged into.
 *
 * @param people - The rows, as the table or an exported trace holds them.
 */
export function extractedFromPeopleRows(people: readonly unknown[]): ExtractedPerson[] {
  return people.flatMap((row: unknown): ExtractedPerson[] => {
    const person = record(row);
    const name = typeof person?.displayName === 'string' ? person.displayName : undefined;
    const evidence = Array.isArray(person?.evidence) ? person.evidence : [];
    if (name === undefined) return [];
    const email = typeof person?.primaryEmail === 'string' ? person.primaryEmail : undefined;
    const refs = new Set(
      evidence.flatMap((item: unknown): string[] => {
        const quoted = record(item);
        return typeof quoted?.ref === 'string' && quoted.sourceId !== undefined ? [quoted.ref] : [];
      }),
    );
    return [...refs].map((ref) => ({ ref, name, ...(email === undefined ? {} : { email }) }));
  });
}

/**
 * The people documentation quoted, from an exported trace. The audit export redacts addresses, so
 * a grade from a trace counts no address and misses a person named by theirs; the bed's own
 * people rows (`npx convex export`) are what V10 grades.
 *
 * @param trace - The parsed trace file.
 */
export function extractedFromTrace(trace: unknown): ExtractedPerson[] {
  const people = record(record(trace)?.sections)?.people;
  return Array.isArray(people) ? extractedFromPeopleRows(people) : [];
}

/** A rate as the page prints it. */
function printed(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

/**
 * The grade as one Markdown page: the counts, the rates and every miss.
 *
 * @param grade - The grade.
 */
export function renderGrade(grade: PeopleGrade): string {
  return [
    '# V10: the people extraction over the company bed',
    '',
    `Commit \`${grade.commit}\`, graded ${grade.generatedAt}.`,
    '',
    `Labelled ${grade.labelled}, extracted ${grade.extracted}, found ${grade.truePositives}.`,
    `Precision ${printed(grade.precision)}, recall ${printed(grade.recall)}, F1 ${printed(grade.f1)}.`,
    `Addresses: ${grade.addresses.correct} correct, ${grade.addresses.wrong} wrong, ${grade.addresses.missing} missing.`,
    '',
    ...grade.falseNegatives.map((person) => `Missed: ${person.name} (${person.ref})`),
    ...grade.falsePositives.map(
      (person) => `Not a labelled person: ${person.name} (${person.ref})`,
    ),
    '',
  ].join('\n');
}
