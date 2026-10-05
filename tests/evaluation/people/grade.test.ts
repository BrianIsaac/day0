import { describe, expect, it } from 'vitest';
import {
  extractedFromTrace,
  gradeExtraction,
  renderGrade,
  type ExtractedPerson,
} from '../../../evaluation/people/grade';
import { PEOPLE_LABELS } from '../../../evaluation/people/labels';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NOW = new Date('2026-10-06T03:00:00.000Z');

/** Every labelled person, extracted exactly as labelled. */
const PERFECT: ExtractedPerson[] = PEOPLE_LABELS.map(({ ref, name, email }) => ({
  ref,
  name,
  ...(email === undefined ? {} : { email }),
}));

describe('the people extraction grade (V10)', (): void => {
  it('labels the six people the bed pages name, each with the address its row gives', (): void => {
    expect(
      PEOPLE_LABELS.map((person) => `${person.ref} ${person.name} ${person.email ?? ''}`),
    ).toEqual([
      'onboarding.md Lee Tan lee.tan@kestrel.test',
      'onboarding.md Noor Rahman noor.rahman@kestrel.test',
      'onboarding.md Rowan Hale rowan.hale@kestrel.test',
      'onboarding.md Femi Adeyemi femi.adeyemi@kestrel.test',
      'onboarding.md Dana Okafor dana.okafor@kestrel.test',
      'finance/handbook.md Ines Duarte ines.duarte@kestrel.test',
    ]);
  });

  it('grades a perfect extraction 1 on every count', (): void => {
    const grade = gradeExtraction(PEOPLE_LABELS, PERFECT, COMMIT, NOW);
    expect(grade).toMatchObject({
      labelled: 6,
      extracted: 6,
      truePositives: 6,
      precision: 1,
      recall: 1,
      f1: 1,
      addresses: { correct: 6, wrong: 0, missing: 0 },
      falsePositives: [],
      falseNegatives: [],
    });
  });

  it('counts a role taken for a person against precision and a person missed against recall', (): void => {
    const grade = gradeExtraction(
      PEOPLE_LABELS,
      [
        ...PERFECT.slice(0, 5),
        { ref: 'onboarding.md', name: 'Messaging administrator' },
        { ref: 'finance/handbook.md', name: 'Lee Tan' },
      ],
      COMMIT,
      NOW,
    );
    expect(grade).toMatchObject({ truePositives: 5, extracted: 7, labelled: 6 });
    expect(grade.precision).toBeCloseTo(5 / 7);
    expect(grade.recall).toBeCloseTo(5 / 6);
    expect(grade.falsePositives.map((person) => person.name)).toEqual([
      'Messaging administrator',
      'Lee Tan',
    ]);
    expect(grade.falseNegatives.map((person) => person.name)).toEqual(['Ines Duarte']);
  });

  it('matches a person merged under another name by the address the page gave', (): void => {
    const grade = gradeExtraction(
      PEOPLE_LABELS,
      [
        ...PERFECT.filter((person) => person.name !== 'Rowan Hale'),
        { ref: 'onboarding.md', name: 'rowan.hale@kestrel.test', email: 'rowan.hale@kestrel.test' },
      ],
      COMMIT,
      NOW,
    );
    expect(grade.truePositives).toBe(6);
  });

  it('counts a wrong or missing address on a person found', (): void => {
    const grade = gradeExtraction(
      PEOPLE_LABELS,
      [
        ...PERFECT.slice(2),
        { ref: 'onboarding.md', name: 'Lee Tan', email: 'lee@elsewhere.test' },
        { ref: 'onboarding.md', name: 'Noor Rahman' },
      ],
      COMMIT,
      NOW,
    );
    expect(grade.addresses).toEqual({ correct: 4, wrong: 1, missing: 1 });
  });

  it("reads the documentation's people out of an exported trace, one per page each was quoted on", (): void => {
    const trace = {
      sections: {
        people: [
          {
            displayName: 'Dana Okafor',
            primaryEmail: 'dana.okafor@kestrel.test',
            source: 'documentation',
            evidence: [
              {
                quote: 'Dana Okafor ...',
                where: 'Kestrel Supply onboarding',
                at: 1,
                ref: 'onboarding.md',
                sourceId: 's1',
              },
              {
                quote: 'Dana Okafor ...',
                where: 'Kestrel Supply onboarding',
                at: 2,
                ref: 'onboarding.md',
                sourceId: 's1',
              },
            ],
          },
          {
            displayName: 'Priya Shah',
            source: 'one-to-one',
            evidence: [{ quote: 'Priya Shah for pipeline.', where: 'the one-to-one', at: 1 }],
          },
        ],
      },
    };
    expect(extractedFromTrace(trace)).toEqual([
      { ref: 'onboarding.md', name: 'Dana Okafor', email: 'dana.okafor@kestrel.test' },
    ]);
    expect(extractedFromTrace({})).toEqual([]);
  });

  it('renders the numbers and every miss as one page', (): void => {
    const page = renderGrade(gradeExtraction(PEOPLE_LABELS, PERFECT.slice(1), COMMIT, NOW));
    expect(page).toContain('Precision 1.000, recall 0.833, F1 0.909');
    expect(page).toContain('Missed: Lee Tan (onboarding.md)');
  });
});
