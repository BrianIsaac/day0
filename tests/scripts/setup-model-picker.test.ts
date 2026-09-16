import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURATED_MODELS,
  defaultModel,
  formatBytes,
  manifestListingCommand,
  modelIdFromManifestPath,
  modelMenu,
  modelMenuLines,
  parseManifestListing,
  parseOllamaList,
  pickModel,
} from '../../scripts/models';
import { hardwareLine, readEnvValues, runSetup, sequenceSteps } from '../../scripts/setup';
import { cleanupCheckouts, harness, ran, realRoute } from './setup-harness';

afterEach(cleanupCheckouts);

const OLLAMA_LIST = [
  'NAME                       ID              SIZE      MODIFIED    ',
  'qwen3:4b                   2bfd38a7daaf    2.6 GB    2 weeks ago    ',
  'llama3.2:3b                a80c4f17acd5    2.0 GB    6 weeks ago    ',
  '',
].join('\n');

/** One manifest line as the volume listing prints it, sized like the real qwen3:8b. */
function manifestLine(path: string, layerSizes: readonly number[]): string {
  const layers = layerSizes.map((size) => ({
    mediaType: 'application/vnd.ollama.image.model',
    digest: `sha256:${'a'.repeat(64)}`,
    size,
  }));
  return `${path}\t${JSON.stringify({ schemaVersion: 2, config: { size: 487 }, layers })}`;
}

const QWEN3_8B_MANIFEST = manifestLine('registry.ollama.ai/library/qwen3/8b', [5225374496, 1723, 11346]);

describe('the curated list', (): void => {
  it('names qwen3:8b as tested on the semi-final local bed, in one place', (): void => {
    expect(CURATED_MODELS.map((model) => model.id)).toEqual(['qwen3:8b']);
    expect(CURATED_MODELS[0].tested).toContain('semi-final local bed');
    expect(CURATED_MODELS[0].downloadLabel).toContain('5.2 GB');
    // The tested note lives in scripts/models.ts and nowhere else in the setup.
    expect(readFileSync('scripts/setup.ts', 'utf8')).not.toContain('semi-final local bed');
  });
});

describe('reading what the volume holds', (): void => {
  it('reads `ollama list` past its header, keeping the size column', (): void => {
    expect(parseOllamaList(OLLAMA_LIST)).toEqual([
      { id: 'qwen3:4b', sizeLabel: '2.6 GB' },
      { id: 'llama3.2:3b', sizeLabel: '2.0 GB' },
    ]);
    expect(parseOllamaList('')).toEqual([]);
  });

  it('turns a manifest path into the id `ollama list` would print', (): void => {
    expect(modelIdFromManifestPath('registry.ollama.ai/library/qwen3/8b')).toBe('qwen3:8b');
    expect(modelIdFromManifestPath('registry.ollama.ai/someone/model/latest')).toBe('someone/model:latest');
    expect(modelIdFromManifestPath('hf.co/user/model/Q4_K_M')).toBe('hf.co/user/model:Q4_K_M');
    expect(modelIdFromManifestPath('registry.ollama.ai/library')).toBeUndefined();
  });

  it('sums a manifest’s layers and prints the size as ollama does', (): void => {
    expect(formatBytes(5225374496)).toBe('5.2 GB');
    expect(formatBytes(621_000_000)).toBe('621 MB');
    expect(parseManifestListing(`${QWEN3_8B_MANIFEST}\nnot a manifest line\n`)).toEqual([
      { id: 'qwen3:8b', sizeLabel: '5.2 GB' },
    ]);
    expect(parseManifestListing('registry.ollama.ai/library/x/y\t{broken')).toEqual([]);
  });

  it('mounts the volume read-only and reads it through the pinned image', (): void => {
    const command = manifestListingCommand('p_model_data', 'node:22-alpine@sha256:abc');
    expect(command.slice(0, 5)).toEqual(['run', '--rm', '-v', 'p_model_data:/ollama:ro', 'node:22-alpine@sha256:abc']);
    expect(command.join(' ')).toContain('/ollama/models/manifests');
  });
});

describe('the menu', (): void => {
  it('lists present models first, tested ones ahead, then the curated ones to pull', (): void => {
    const menu = modelMenu([
      { id: 'qwen3:4b', sizeLabel: '2.6 GB' },
      { id: 'llama3.2:3b', sizeLabel: '2.0 GB' },
    ]);
    expect(menu.map((entry) => [entry.id, entry.mark])).toEqual([
      ['llama3.2:3b', 'present, 2.0 GB'],
      ['qwen3:4b', 'present, 2.6 GB'],
      ['qwen3:8b', 'will pull (about 5.2 GB)'],
    ]);
    const withTested = modelMenu([
      { id: 'qwen3:4b', sizeLabel: '2.6 GB' },
      { id: 'qwen3:8b', sizeLabel: '5.2 GB' },
    ]);
    expect(withTested.map((entry) => entry.id)).toEqual(['qwen3:8b', 'qwen3:4b']);
    expect(withTested[0].tested).toContain('semi-final');
    expect(withTested[0].mark).toBe('present, 5.2 GB');
  });

  it('adds the file’s own model when it is neither present nor curated', (): void => {
    const menu = modelMenu([], 'mistral:7b');
    expect(menu.map((entry) => entry.id)).toEqual(['qwen3:8b', 'mistral:7b']);
    expect(menu[1]).toMatchObject({ present: false, mark: 'will pull', configured: true });
  });

  it('defaults to the file’s model, else the first present, else the first curated', (): void => {
    expect(defaultModel(modelMenu([]))?.id).toBe('qwen3:8b');
    expect(defaultModel(modelMenu([{ id: 'qwen3:4b', sizeLabel: '2.6 GB' }]))?.id).toBe('qwen3:4b');
    expect(
      defaultModel(
        modelMenu(
          [
            { id: 'qwen3:4b', sizeLabel: '2.6 GB' },
            { id: 'qwen3:8b', sizeLabel: '5.2 GB' },
          ],
          'qwen3:4b',
        ),
      )?.id,
    ).toBe('qwen3:4b');
  });

  it('reads a number, an id or nothing at the picker', (): void => {
    const menu = modelMenu([{ id: 'qwen3:4b', sizeLabel: '2.6 GB' }]);
    const fallback = defaultModel(menu);
    expect(pickModel(menu, '', fallback)?.id).toBe('qwen3:4b');
    expect(pickModel(menu, '2', fallback)?.id).toBe('qwen3:8b');
    expect(pickModel(menu, 'qwen3:8b', fallback)?.id).toBe('qwen3:8b');
    expect(pickModel(menu, '3', fallback)).toBeUndefined();
    expect(pickModel(menu, 'y', fallback)).toBeUndefined();
  });

  it('prints one numbered line per entry with the marks and notes', (): void => {
    const lines = modelMenuLines(modelMenu([{ id: 'qwen3:4b', sizeLabel: '2.6 GB' }], 'qwen3:4b'));
    expect(lines[0]).toMatch(/^ {2}1 {2}qwen3:4b {2}present, 2\.6 GB {2}\(in \.env\.local\)$/);
    expect(lines[1]).toMatch(/^ {2}2 {2}qwen3:8b {2}will pull \(about 5\.2 GB\) {2}\(tested: /);
    expect(hardwareLine(undefined)).toContain('CPU');
    expect(hardwareLine(23000)).toContain('23000 MiB free');
  });

  it('drops the pull step only when told the model is present', (): void => {
    expect(sequenceSteps('local', { mode: 'real', pull: false })).not.toContain('model:pull');
    expect(sequenceSteps('local', { mode: 'real', pull: true })).toContain('model:pull');
    expect(sequenceSteps('local', { mode: 'real' })).toContain('model:pull');
    expect(sequenceSteps('local')).toContain('model:pull');
  });
});

describe('the picker inside a real-mode run on the local route', (): void => {
  const localRoute = (overrides = {}): ReturnType<typeof realRoute> =>
    realRoute({ route: 'local', assumeYes: false, ...overrides });

  it('lists what the running service reports, then the curated model, in that order', async (): Promise<void> => {
    const h = harness({
      services: ['backend', 'model', 'sandbox', 'redactor'],
      ollamaList: OLLAMA_LIST,
      interactive: true,
      answers: ['1'],
    });
    expect(await runSetup(localRoute(), h.io)).toBe(0);
    const printed = h.output.join('\n');
    const at = (text: string): number => printed.indexOf(text);
    expect(at('Models for the bundled service, Compose project day0-setup-test:')).toBeGreaterThan(-1);
    expect(printed).toContain('what `ollama list` reports in the running service');
    expect(at('1  llama3.2:3b  present, 2.0 GB')).toBeLessThan(at('2  qwen3:4b     present, 2.6 GB'));
    expect(at('2  qwen3:4b     present, 2.6 GB')).toBeLessThan(at('3  qwen3:8b     will pull (about 5.2 GB)  (tested: '));
    expect(at('Models for the bundled service')).toBeLessThan(at('Starting. Steps:'));
    expect(printed).toContain('Choose 1-3 [1]: ');
    expect(ran(h)).toContain('exec -T model ollama list');
    expect(ran(h)).not.toContain('/ollama/models/manifests');
  });

  it('reads the volume’s manifests when the service is not running, mounted read-only', async (): Promise<void> => {
    const h = harness({
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-setup-test_model_data'],
      manifestListing: `${QWEN3_8B_MANIFEST}\n`,
    });
    expect(await runSetup(localRoute({ assumeYes: true }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('read from the day0-setup-test_model_data volume');
    expect(printed).toContain('1  qwen3:8b  present, 5.2 GB  (tested: ');
    expect(ran(h)).not.toContain('ollama list');
    const read = h.commands.find((call) => call.args.join(' ').includes('/ollama/models/manifests'));
    expect(read?.args).toContain('day0-setup-test_model_data:/ollama:ro');
  });

  it('--model skips the picker and pulls a model that is not present', async (): Promise<void> => {
    const h = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST });
    expect(await runSetup(localRoute({ model: 'qwen3:8b' }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).not.toContain('Choose 1-');
    expect(printed).toContain('qwen3:8b: not present, so it is pulled first.');
    expect(ran(h)).toContain('run model:pull qwen3:8b');
    expect(readEnvValues(join(h.directory, '.env.local')).OPENAI_MODEL).toBe('qwen3:8b');
  });

  it('--yes takes the first present model without pulling, else the first curated one and pulls it', async (): Promise<void> => {
    const present = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST });
    expect(await runSetup(localRoute({ assumeYes: true }), present.io)).toBe(0);
    expect(present.output.join('\n')).toContain('--yes: llama3.2:3b (present, 2.0 GB).');
    expect(present.output.join('\n')).toContain('llama3.2:3b is already in the model volume, so nothing is pulled');
    expect(ran(present)).not.toContain('model:pull');
    expect(readEnvValues(join(present.directory, '.env.local')).OPENAI_MODEL).toBe('llama3.2:3b');

    const empty = harness({ services: ['backend', 'model', 'sandbox', 'redactor'] });
    expect(await runSetup(localRoute({ assumeYes: true }), empty.io)).toBe(0);
    expect(empty.output.join('\n')).toContain('nothing is present yet');
    expect(empty.output.join('\n')).toContain('--yes: qwen3:8b (will pull (about 5.2 GB)).');
    expect(ran(empty)).toContain('run model:pull qwen3:8b');
    const steps = /Steps: (.*)/.exec(empty.output.join('\n'))?.[1] ?? '';
    expect(steps.indexOf('model:up')).toBeLessThan(steps.indexOf('model:pull'));
    expect(steps.indexOf('model:pull')).toBeLessThan(steps.indexOf('sandbox:up'));
  });

  it('keeps the model the file already names under --yes, even beside a tested one', async (): Promise<void> => {
    const h = harness({
      envLocal: ['COMPOSE_PROJECT_NAME=day0-setup-test', 'OPENAI_BASE_URL=http://127.0.0.1:11434/v1', 'OPENAI_MODEL=qwen3:4b', ''].join('\n'),
      services: ['backend', 'model', 'sandbox', 'redactor'],
      ollamaList: `${OLLAMA_LIST}qwen3:8b                   500a1f067a9f    5.2 GB    6 weeks ago    \n`,
    });
    expect(await runSetup(localRoute({ assumeYes: true }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('qwen3:4b     present, 2.6 GB  (in .env.local)');
    expect(printed).toContain('--yes: qwen3:4b (present, 2.6 GB).');
    expect(readEnvValues(join(h.directory, '.env.local')).OPENAI_MODEL).toBe('qwen3:4b');
  });

  it('asks on a terminal, takes a number or the default, and cancels on anything else', async (): Promise<void> => {
    const picked = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST, interactive: true, answers: ['3'] });
    expect(await runSetup(localRoute(), picked.io)).toBe(0);
    expect(picked.output.join('\n')).toContain('qwen3:8b: not present, so it is pulled first.');
    expect(ran(picked)).toContain('run model:pull qwen3:8b');

    const defaulted = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST, interactive: true, answers: [''] });
    expect(await runSetup(localRoute(), defaulted.io)).toBe(0);
    expect(readEnvValues(join(defaulted.directory, '.env.local')).OPENAI_MODEL).toBe('llama3.2:3b');

    const declined = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST, interactive: true, answers: ['y'] });
    expect(await runSetup(localRoute(), declined.io)).toBe(130);
    expect(declined.output.join('\n')).toContain('Nothing was written and nothing was started');
    expect(existsSync(join(declined.directory, '.env.local'))).toBe(false);
    expect(ran(declined)).not.toContain('convex:up');
  });

  it('takes the default without asking when stdin is not a terminal, and says so', async (): Promise<void> => {
    const h = harness({ services: ['backend', 'model', 'sandbox', 'redactor'], ollamaList: OLLAMA_LIST, interactive: false });
    h.io.ask = async (): Promise<string> => {
      throw new Error('the picker must not ask off a terminal');
    };
    expect(await runSetup(localRoute(), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('stdin is not a terminal, so llama3.2:3b is taken (present, 2.0 GB); --model <id> chooses another.');
  });

  it('prints the list and the choice on --dry-run, with the pull step only for an absent model', async (): Promise<void> => {
    const present = harness({ services: ['backend', 'model'], ollamaList: OLLAMA_LIST });
    expect(await runSetup(localRoute({ dryRun: true }), present.io)).toBe(0);
    const printed = present.output.join('\n');
    expect(printed).toContain('1  llama3.2:3b  present, 2.0 GB');
    expect(printed).toContain('Would choose llama3.2:3b (present, 2.0 GB); --model <id> chooses another.');
    expect(printed).toContain('Dry run: real mode on the local route');
    expect(printed).toContain('OPENAI_MODEL=llama3.2:3b');
    expect(printed).not.toContain('model:pull');
    expect(printed).toContain('Nothing was written and nothing was started.');
    expect(existsSync(join(present.directory, '.env.local'))).toBe(false);
    expect(present.commands.some((call) => call.command === 'pnpm' && call.args[0] === 'run')).toBe(false);

    const absent = harness();
    expect(await runSetup(localRoute({ dryRun: true }), absent.io)).toBe(0);
    expect(absent.output.join('\n')).toContain('Would choose qwen3:8b (will pull (about 5.2 GB))');
    expect(absent.output.join('\n')).toContain('pnpm run model:pull qwen3:8b');
  });

  it('leaves the mock local route on the hardware question, with no menu', async (): Promise<void> => {
    const h = harness({ services: ['backend', 'sandbox', 'model'], answers: ['y'] });
    expect(await runSetup(realRoute({ mode: 'mock', route: 'local', bossEmail: undefined, assumeYes: false }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).not.toContain('Models for the bundled service');
    expect(printed).toContain('Pull it now? [Y/n] ');
    expect(ran(h)).toContain('run model:pull qwen3:4b');
  });
});
