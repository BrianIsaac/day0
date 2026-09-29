import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_SOURCE,
  CAPTURE_TARGET,
  STEPS_FILE,
  WalkthroughSourceError,
  isoDay,
  parseInline,
  parseRecordedRun,
  typographic,
  readWebpSize,
  recordedRunAt,
  walkthroughDrift,
  writeWalkthrough,
} from '../../scripts/walkthrough-steps';
import { temporaryDirectories } from '../setup/temporary-directories';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const temporaryDirectory = temporaryDirectories();
const measured = (): { width: number; height: number } => ({ width: 800, height: 400 });

/** The README with one exact passage replaced, failing loudly if the passage is not there. */
function edited(from: string, to: string): string {
  expect(README).toContain(from);
  return README.replace(from, to);
}

/** A repository root holding just what the generator reads, with the walkthrough written. */
async function scratchRoot(): Promise<string> {
  const root = temporaryDirectory('day0-walkthrough-');
  for (const file of ['README.md', 'package.json']) cpSync(join(ROOT, file), join(root, file));
  cpSync(join(ROOT, CAPTURE_SOURCE), join(root, CAPTURE_SOURCE), { recursive: true });
  mkdirSync(join(root, 'src/demo'), { recursive: true });
  await writeWalkthrough(root);
  return root;
}

describe('the tracked walkthrough', () => {
  it('is exactly what the README generates, steps and captures alike (the --check)', async () => {
    expect(await walkthroughDrift(ROOT)).toEqual([]);
  });

  it('drifts the moment a step is reworded in the README', async () => {
    const readme = edited(
      '8. **Approve a plan before anything executes.**',
      '8. **Approve the plan before anything executes.**',
    );
    expect(await walkthroughDrift(ROOT, readme)).toEqual([
      `${STEPS_FILE} is not what the README generates`,
    ]);
  });

  it('drifts the moment an elapsed time changes in the README', async () => {
    const readme = edited('Elapsed: 17 min 14 s.', 'Elapsed: 17 min 15 s.');
    expect(await walkthroughDrift(ROOT, readme)).toEqual([
      `${STEPS_FILE} is not what the README generates`,
    ]);
  });
});

describe('writing the walkthrough', () => {
  it('copies every capture the steps show and reports a stray or changed copy', async () => {
    const root = await scratchRoot();
    expect(await walkthroughDrift(root)).toEqual([]);

    writeFileSync(join(root, CAPTURE_TARGET, 'full-run-99-stray.webp'), 'stray');
    const changed = join(root, CAPTURE_TARGET, 'full-run-04-cards-proposed.webp');
    writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from([0])]));
    expect(await walkthroughDrift(root)).toEqual([
      `${CAPTURE_TARGET}/full-run-04-cards-proposed.webp differs from ${CAPTURE_SOURCE}/full-run-04-cards-proposed.webp`,
      `${CAPTURE_TARGET}/full-run-99-stray.webp is served but no step shows it`,
    ]);

    await writeWalkthrough(root);
    expect(await walkthroughDrift(root)).toEqual([]);
  });
});

describe('the README run as the page reads it', () => {
  const run = recordedRunAt(ROOT);

  it('has the sixteen steps in order, each titled by its bold lead', () => {
    expect(run.steps.map((step) => step.number)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    for (const step of run.steps) expect(README).toContain(`${step.number}. **${step.title}**`);
  });

  it('dates the run from its "It ran on" sentence', () => {
    expect(run.runOn).toBe('2026-09-03');
  });

  it('times a step only where the README states an elapsed time, from step 2 on (W D4)', () => {
    expect(run.steps.map((step) => step.elapsedSeconds)).toEqual([
      null,
      274,
      308,
      432,
      545,
      805,
      965,
      1034,
      1235,
      1271,
      1381,
      1756,
      2124,
      2362,
      2425,
      2925,
    ]);
  });

  it('keeps each paragraph whole but for its elapsed sentence, with code and bold as spans', () => {
    const [first, , third, fourth] = run.steps;
    expect(first!.body).toContainEqual({ text: 'DAY0_DOCS_HOST_DIR', code: true });
    expect(third!.body).toContainEqual({ text: '5 min 8 s', strong: true });
    const text = fourth!.body.map((span) => span.text).join('');
    expect(text).toMatch(/^About two minutes after the charter was approved/);
    expect(text).toMatch(/including the manager\u2019s own words from the one-to-one\.$/);
    expect(text).not.toContain('Elapsed');
  });

  it('serves each capture from public/walkthrough with the README alt text and its real size', () => {
    const fourth = run.steps[3]!;
    expect(fourth.capture).toEqual({
      src: '/walkthrough/full-run-04-cards-proposed.webp',
      width: 1180,
      height: 152,
      alt: 'The Surfaces tab after orientation, showing the Linear and Slack cards proposed with their approved connection ladders',
    });
  });

  it('captions each capture without the day it was taken, which the run carries once', () => {
    expect(run.steps[0]!.caption).toBe(
      'Both documentation sources synced before the agent existed.',
    );
    for (const step of run.steps) expect(step.caption).not.toContain('Captured locally');
  });

  it('carries the deviations a reader should know, each by its bold lead', () => {
    expect(run.deviations.map((deviation) => deviation.lead)).toEqual([
      'The manager email is not in the setup list, and Slack needs it.',
      'The one-to-one asked one question the answers did not cover.',
      'The queue chose its own order.',
      'The tile refresh was carried by the Slack ask.',
      'A run that ends with a question has no rejection to make.',
      'Reconciliation is asked for more often than the walkthrough implies.',
      'The switch confirms on the way on, not on the way off.',
    ]);
    expect(run.deviations[0]!.body).toContainEqual({
      text: 'NEXT_PUBLIC_DEMO_BOSS_EMAIL',
      code: true,
    });
    expect(run.deviations[6]!.body).toEqual([]);
  });
});

describe('what the parser refuses rather than shows wrong', () => {
  it.each([
    [
      'a step out of order',
      '9. **A web-only system arrives',
      '10. **A web-only system arrives',
      /step 10 follows step 8/,
    ],
    [
      'a caption from another day',
      '*A plan waiting for a decision. Nothing has executed. Captured locally on 3 September 2026.*',
      '*A plan waiting for a decision. Nothing has executed. Captured locally on 4 September 2026.*',
      /step 8 was captured on another day/,
    ],
    [
      'a link in a paragraph',
      'The manager approved the plan. Elapsed: 17 min 14 s.',
      'The manager approved [the plan](#x). Elapsed: 17 min 14 s.',
      /unrecognised markup "\["/,
    ],
    [
      'an elapsed time it cannot read',
      'Elapsed: 17 min 14 s.',
      'Elapsed: about 17 minutes.',
      /an "Elapsed:" the parser cannot read/,
    ],
    [
      'a capture not named for its step',
      '(.github/images/full-run-08-plan-held.webp)',
      '(.github/images/full-run-09-plan-held.webp)',
      /step 8's capture/,
    ],
    [
      'a step with no caption',
      '   *A plan waiting for a decision. Nothing has executed. Captured locally on 3 September 2026.*\n',
      '',
      /step 8 has no capture and caption|unrecognised line/,
    ],
    [
      'a line of a kind it does not know',
      '   *The whole sign-in and save sequence',
      '   > A quote the page would drop.\n\n   *The whole sign-in and save sequence',
      /unrecognised line after step 9/,
    ],
    [
      'a heading that would end the steps early',
      '9. **A web-only system arrives',
      '### An interruption\n\n9. **A web-only system arrives',
      /"### An interruption" interrupts the steps/,
    ],
    [
      'markup in a caption',
      '*A plan waiting for a decision.',
      '*A plan waiting for a `decision`.',
      /markup where the page shows plain text/,
    ],
    [
      'markup in a title',
      '8. **Approve a plan before anything executes.**',
      '8. **Approve a [plan](#x) before anything executes.**',
      /unrecognised markup "\["/,
    ],
    [
      'markup in alt text',
      '![A held execution plan',
      '![A held `execution` plan',
      /markup where the page shows plain text/,
    ],
  ])('refuses %s', (_, from, to, message) => {
    expect(() => parseRecordedRun(edited(from, to), measured)).toThrow(message);
    expect(() => parseRecordedRun(edited(from, to), measured)).toThrow(WalkthroughSourceError);
  });

  it('refuses a README without the section', () => {
    expect(() => parseRecordedRun('# Day0\n', measured)).toThrow(/no "## One full run/);
  });
});

describe('parseInline', () => {
  it('splits code spans and bold from plain text', () => {
    expect(parseInline('a `b` and **c**.')).toEqual([
      { text: 'a ' },
      { text: 'b', code: true },
      { text: ' and ' },
      { text: 'c', strong: true },
      { text: '.' },
    ]);
  });

  it('keeps markup characters that sit inside a code span', () => {
    expect(parseInline('`<record-id>` and `a_b`')).toEqual([
      { text: '<record-id>', code: true },
      { text: ' and ' },
      { text: 'a_b', code: true },
    ]);
  });
});

describe('typographic', () => {
  it('sets an apostrophe inside a word typographically and leaves every other quote alone', () => {
    expect(typographic("the manager's own words")).toBe('the manager\u2019s own words');
    expect(typographic("'quoted' and 5'")).toBe("'quoted' and 5'");
  });

  it('never touches a code span', () => {
    expect(parseInline("the ask's `a'b`")).toEqual([
      { text: 'the ask\u2019s ' },
      { text: "a'b", code: true },
    ]);
  });
});

describe('isoDay', () => {
  it('reads a British date', () => {
    expect(isoDay('3 September 2026')).toBe('2026-09-03');
    expect(isoDay('28 February 2027')).toBe('2027-02-28');
  });

  it('refuses a month it does not know', () => {
    expect(() => isoDay('3 Sept 2026')).toThrow(WalkthroughSourceError);
  });
});

describe('readWebpSize', () => {
  /** A RIFF WebP container around one chunk whose first bytes are `payload`. */
  function webp(chunk: string, payload: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(40);
    bytes.set(Buffer.from('RIFF'), 0);
    bytes.set(Buffer.from('WEBP'), 8);
    bytes.set(Buffer.from(chunk), 12);
    bytes.set(payload, 20);
    return bytes;
  }

  it('reads a lossy capture from the tree', () => {
    const bytes = readFileSync(join(ROOT, CAPTURE_SOURCE, 'full-run-04-cards-proposed.webp'));
    expect(readWebpSize(bytes)).toEqual({ width: 1180, height: 152 });
  });

  it('reads a lossless header', () => {
    // 640 x 518: width - 1 in the low 14 bits, height - 1 in the next 14, after the 0x2f signature.
    const bits = 639 | (517 << 14);
    const payload = [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24];
    expect(readWebpSize(webp('VP8L', payload))).toEqual({
      width: 640,
      height: 518,
    });
  });

  it('reads an extended header', () => {
    // Flags and reserved bytes, then the canvas width - 1 and height - 1 as 24-bit numbers.
    const payload = [0, 0, 0, 0, 0x4f, 0x04, 0x00, 0x1f, 0x01, 0x00];
    expect(readWebpSize(webp('VP8X', payload))).toEqual({ width: 1104, height: 288 });
  });

  it('refuses bytes that are not a WebP image', () => {
    expect(() => readWebpSize(new Uint8Array(40))).toThrow('not a WebP image');
  });
});
