/**
 * Generate the walkthrough's steps from the README and check that the tracked ones are current.
 *
 *   pnpm exec tsx scripts/walkthrough-steps.ts           write the steps and copy the captures
 *   pnpm exec tsx scripts/walkthrough-steps.ts --check   exit 1 when either has drifted
 *
 * The README's "One full run, from the first page" section is the source: each numbered step's
 * bold lead, paragraph, `Elapsed:` time, capture, alt text and caption, the day the run took
 * place, and the "Deviations a reader should know" beneath it. The script writes them to
 * `src/demo/walkthrough-steps.json` and copies each capture from `.github/images/` into
 * `public/walkthrough/` with the size its WebP header states, so `/walkthrough` and the README
 * cannot tell two stories. Anything in the section the parser does not recognise is an error,
 * never skipped: a new kind of line is a change the page has to be taught. The gate runs the
 * check (`tests/scripts/walkthrough-steps.test.ts`).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import type { RecordedRun, RunDeviation, RunSpan, RunStep, RunText } from '../src/demo/walkthrough';

/** Where the README keeps its captures. */
export const CAPTURE_SOURCE = '.github/images';
/** Where the page serves them from, relative to the repository root. */
export const CAPTURE_TARGET = 'public/walkthrough';
/** The generated steps, relative to the repository root. */
export const STEPS_FILE = 'src/demo/walkthrough-steps.json';

const RUN_HEADING = '## One full run, from the first page';
const DEVIATIONS_HEADING = '### Deviations a reader should know';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A capture's pixel size, from its WebP header. */
export interface CaptureSize {
  readonly width: number;
  readonly height: number;
}

/** What the parser takes from the README before a capture is measured. */
interface ParsedStep extends Omit<RunStep, 'capture'> {
  readonly file: string;
  readonly alt: string;
}

/** A README section whose shape the parser does not recognise. */
export class WalkthroughSourceError extends Error {}

function fail(message: string): never {
  throw new WalkthroughSourceError(`README "One full run": ${message}`);
}

/** The lines under one README heading, up to the next heading of any level. */
function section(readme: string, heading: string): string[] {
  const lines = readme.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) fail(`no "${heading}" heading`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,6} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** `3 September 2026` as `2026-09-03`. */
export function isoDay(text: string): string {
  const match = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(text);
  const month = MONTHS.findIndex((name) => name === match?.[2]);
  if (!match || month === -1) fail(`"${text}" is not a day the parser reads`);
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
}

/**
 * A paragraph's inline markdown as spans. Code spans and bold are the only markup the section
 * uses; anything else (a link, emphasis, an HTML tag) is refused rather than shown raw.
 */
export function parseInline(text: string): RunText {
  const spans: RunSpan[] = [];
  for (const [index, part] of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).entries()) {
    if (part === '') continue;
    if (index % 2 === 1) {
      spans.push(
        part.startsWith('`')
          ? { text: part.slice(1, -1), code: true }
          : { text: part.slice(2, -2), strong: true },
      );
      continue;
    }
    const markup = /[`*_[\]<>]/.exec(part);
    if (markup) fail(`unrecognised markup "${markup[0]}" in "${text}"`);
    spans.push({ text: part });
  }
  return spans;
}

/** `Elapsed: 7 min 12 s.` at the end of a paragraph, as seconds and the paragraph without it. */
function splitElapsed(paragraph: string): { body: string; elapsedSeconds: number | null } {
  const match = /\s*Elapsed: (?:(\d+) min )?(\d+) s\.$/.exec(paragraph);
  const body = match ? paragraph.slice(0, match.index) : paragraph;
  if (body.includes('Elapsed:')) fail(`an "Elapsed:" the parser cannot read in "${paragraph}"`);
  return {
    body,
    elapsedSeconds: match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : null,
  };
}

/** The day the run took place, from the section's "It ran on" sentence. */
function runDay(lines: readonly string[]): string {
  const sentence = lines.map((line) => /It ran on (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(line));
  const found = sentence.find((match) => match !== null);
  if (!found) fail('no "It ran on <day>" sentence');
  return isoDay(found[1]!);
}

/** The numbered steps, each with its capture and caption, in order from 1. */
function parseSteps(lines: readonly string[], runOn: string): ParsedStep[] {
  const steps: Array<Partial<ParsedStep> & Pick<ParsedStep, 'number'>> = [];
  for (const line of lines) {
    const lead = /^(\d+)\. \*\*([^*]+)\*\* (.+)$/.exec(line);
    const image = /^\s+!\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    const caption = /^\s+\*([^*]+)\*$/.exec(line);
    const current = steps.at(-1);
    if (lead) {
      const number = Number(lead[1]);
      if (number !== steps.length + 1) fail(`step ${number} follows step ${steps.length}`);
      const { body, elapsedSeconds } = splitElapsed(lead[3]!);
      steps.push({
        number,
        title: parseInline(lead[2]!)
          .map((span) => span.text)
          .join(''),
        body: parseInline(body),
        elapsedSeconds,
      });
    } else if (image && current && current.file === undefined) {
      const file = image[2]!.replace(`${CAPTURE_SOURCE}/`, '');
      const expected = `full-run-${String(current.number).padStart(2, '0')}-`;
      if (!image[2]!.startsWith(`${CAPTURE_SOURCE}/`) || !file.startsWith(expected)) {
        fail(
          `step ${current.number}'s capture "${image[2]}" is not ${CAPTURE_SOURCE}/${expected}*`,
        );
      }
      steps[steps.length - 1] = { ...current, file, alt: image[1]! };
    } else if (caption && current?.file !== undefined && current.caption === undefined) {
      const dated = /^(.+?) Captured locally on (\d{1,2} [A-Z][a-z]+ \d{4})\.$/.exec(caption[1]!);
      if (!dated) fail(`step ${current.number}'s caption does not end with the day it was taken`);
      if (isoDay(dated[2]!) !== runOn) fail(`step ${current.number} was captured on another day`);
      steps[steps.length - 1] = { ...current, caption: dated[1]! };
    } else if (line.trim() !== '' && steps.length > 0) {
      fail(`unrecognised line after step ${steps.length}: "${line.trim()}"`);
    }
  }
  if (steps.length === 0) fail('no numbered steps');
  return steps.map((step) => {
    if (step.file === undefined || step.alt === undefined || step.caption === undefined) {
      fail(`step ${step.number} has no capture and caption`);
    }
    return step as ParsedStep;
  });
}

/** The deviations list: each item's bold lead and the text after it. */
function parseDeviations(lines: readonly string[]): RunDeviation[] {
  const items = lines.filter((line) => line.trim() !== '');
  if (items.length === 0) fail('no deviations');
  return items.map((line) => {
    const item = /^- \*\*([^*]+)\*\*(?: (.+))?$/.exec(line);
    if (!item) fail(`unrecognised deviation "${line}"`);
    return { lead: item[1]!, body: item[2] === undefined ? [] : parseInline(item[2]) };
  });
}

/**
 * The run as the README states it, each capture measured by `measure` (given the capture's file
 * name under `.github/images/`).
 *
 * @throws WalkthroughSourceError when the section has a shape the parser does not recognise.
 */
export function parseRecordedRun(
  readme: string,
  measure: (file: string) => CaptureSize,
): RecordedRun {
  const run = section(readme, RUN_HEADING);
  const runOn = runDay(run);
  const firstStep = run.findIndex((line) => /^1\. /.test(line));
  const steps = parseSteps(firstStep === -1 ? [] : run.slice(firstStep), runOn);
  return {
    runOn,
    steps: steps.map(({ file, alt, ...step }) => ({
      ...step,
      capture: { src: `/walkthrough/${file}`, ...measure(file), alt },
    })),
    deviations: parseDeviations(section(readme, DEVIATIONS_HEADING)),
  };
}

/**
 * A WebP image's canvas size from its header: the lossy (`VP8 `), lossless (`VP8L`) and extended
 * (`VP8X`) forms.
 *
 * @throws Error when the bytes are not a WebP image.
 */
export function readWebpSize(bytes: Uint8Array): CaptureSize {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 30 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
    throw new Error('not a WebP image');
  }
  const u24 = (offset: number): number => view.getUint32(offset, true) & 0xffffff;
  switch (tag(12)) {
    case 'VP8 ':
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    case 'VP8L': {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: u24(24) + 1, height: u24(27) + 1 };
    default:
      throw new Error(`a WebP chunk this reader does not know: "${tag(12)}"`);
  }
}

/** The run from the README at `root`, or from `readme` in its place, with its captures measured. */
export function recordedRunAt(root: string, readme?: string): RecordedRun {
  return parseRecordedRun(readme ?? readFileSync(join(root, 'README.md'), 'utf8'), (file) =>
    readWebpSize(readFileSync(join(root, CAPTURE_SOURCE, file))),
  );
}

/** The steps file as the tracked copy must read, formatted as the repository's Prettier formats it. */
export async function renderSteps(root: string, run: RecordedRun): Promise<string> {
  const options = await resolveConfig(join(root, STEPS_FILE));
  return format(JSON.stringify(run), { ...options, filepath: join(root, STEPS_FILE) });
}

/** The capture file names a run serves. */
function captureFiles(run: RecordedRun): string[] {
  return run.steps.map((step) => step.capture.src.replace('/walkthrough/', ''));
}

/**
 * Every way the tracked steps and captures differ from what the README at `root` (or `readme` in
 * its place) generates; empty when they are current.
 */
export async function walkthroughDrift(root: string, readme?: string): Promise<string[]> {
  const run = recordedRunAt(root, readme);
  const drift: string[] = [];
  const stepsPath = join(root, STEPS_FILE);
  if (
    !existsSync(stepsPath) ||
    readFileSync(stepsPath, 'utf8') !== (await renderSteps(root, run))
  ) {
    drift.push(`${STEPS_FILE} is not what the README generates`);
  }
  const expected = captureFiles(run);
  const target = join(root, CAPTURE_TARGET);
  const present = existsSync(target) ? readdirSync(target) : [];
  for (const file of expected) {
    const copy = join(target, file);
    if (!existsSync(copy)) drift.push(`${CAPTURE_TARGET}/${file} is missing`);
    else if (!readFileSync(copy).equals(readFileSync(join(root, CAPTURE_SOURCE, file)))) {
      drift.push(`${CAPTURE_TARGET}/${file} differs from ${CAPTURE_SOURCE}/${file}`);
    }
  }
  for (const file of present.filter((name) => !expected.includes(name))) {
    drift.push(`${CAPTURE_TARGET}/${file} is served but no step shows it`);
  }
  return drift;
}

/** Write the steps file and the captures, removing any capture no step shows. */
export async function writeWalkthrough(root: string): Promise<RecordedRun> {
  const run = recordedRunAt(root);
  writeFileSync(join(root, STEPS_FILE), await renderSteps(root, run));
  const target = join(root, CAPTURE_TARGET);
  mkdirSync(target, { recursive: true });
  const expected = captureFiles(run);
  for (const file of readdirSync(target).filter((name) => !expected.includes(name))) {
    rmSync(join(target, file));
  }
  for (const file of expected) copyFileSync(join(root, CAPTURE_SOURCE, file), join(target, file));
  return run;
}

/** Write the walkthrough, or with `--check` report whether it is current. */
async function main(argv: readonly string[]): Promise<number> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (argv.includes('--check')) {
    const drift = await walkthroughDrift(root);
    for (const line of drift) console.error(line);
    if (drift.length > 0) {
      console.error('Run `pnpm exec tsx scripts/walkthrough-steps.ts` and commit the result.');
    }
    return drift.length === 0 ? 0 : 1;
  }
  const run = await writeWalkthrough(root);
  console.log(
    `Wrote ${run.steps.length} steps to ${STEPS_FILE} and their captures to ${CAPTURE_TARGET}.`,
  );
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
