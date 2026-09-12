import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { restoreCommand, snapshotCommand } from '../../scripts/demo-bed';

describe('snapshot filenames at the container command boundary', () => {
  it.each(['snapshot', 'restore'])('keeps spaces and shell syntax literal during %s', (operation) => {
    const directory = mkdtempSync(join(tmpdir(), 'day0-tar-args-'));
    const filename = 'bed sample; echo injected.tar.gz';
    writeFileSync(join(directory, 'tar'), '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n', { mode: 0o755 });
    try {
      const args = operation === 'snapshot'
        ? snapshotCommand('fixture', directory, filename)
        : restoreCommand(directory, filename, 'day0-sweep_fixture');
      const image = args.findIndex((arg) => arg.startsWith('node:22-alpine@'));
      const command = args.slice(image + 1);
      const result = spawnSync(command[0], command.slice(1), {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(operation === 'snapshot'
        ? ['czf', `/to/${filename}`, '-C', '/from', '.']
        : ['xzf', `/from/${filename}`, '-C', '/to']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
