import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeStructuredOutputRecord } from '../../scripts/eval-structured-output';

const evidence = {
  generatedAt: '2026-09-12T07:01:00.000Z',
  runs: [
    {
      id: 'baseline-r1',
      arm: 'baseline',
      tasks: [
        {
          taskId: 'docs-team-cadence',
          startedAt: '2026-09-12T07:00:00.000Z',
          finishedAt: '2026-09-12T07:00:03.000Z',
          modelCalls: { logicalStages: 1 },
        },
      ],
    },
  ],
};

const directories: string[] = [];

async function evidenceDirectory(): Promise<{ evidencePath: string; logsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'structured-output-'));
  directories.push(directory);
  const evidencePath = join(directory, 'comparison.json');
  const logsPath = join(directory, 'function-logs.jsonl');
  await writeFile(evidencePath, JSON.stringify(evidence), 'utf8');
  await writeFile(logsPath, '', 'utf8');
  return { evidencePath, logsPath };
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('the structured-output command', (): void => {
  it('writes the record beside the evidence file', async (): Promise<void> => {
    const { evidencePath, logsPath } = await evidenceDirectory();
    const { output, record } = writeStructuredOutputRecord(evidencePath, logsPath);
    expect(output).toBe(evidencePath.replace(/comparison\.json$/, 'structured-output.json'));
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(record);
    expect(record.rows).toEqual([
      expect.objectContaining({ runId: 'baseline-r1', coverage: 'not-used-by-tool-loop' }),
    ]);
  });

  it('refuses to overwrite a record already in the evidence directory', async (): Promise<void> => {
    const { evidencePath, logsPath } = await evidenceDirectory();
    const existing = evidencePath.replace(/comparison\.json$/, 'structured-output.json');
    await writeFile(existing, '{"frozen":true}\n', 'utf8');
    expect(() => writeStructuredOutputRecord(evidencePath, logsPath)).toThrow(
      `a structured-output record already exists at ${existing}`,
    );
    expect(await readFile(existing, 'utf8')).toBe('{"frozen":true}\n');
  });
});
