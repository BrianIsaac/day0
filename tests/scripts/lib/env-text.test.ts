import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envFileLines, parseEnvText } from '../../../scripts/lib/env-text';

const directories: string[] = [];

afterEach((): void => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('parseEnvText: the one reader of .env.local (W17-R24)', (): void => {
  it('reads each quote as dotenv does, and a double-quoted value with its escapes', (): void => {
    expect(
      Object.fromEntries(
        parseEnvText(
          [
            'SINGLE=\'a "b" # c\'',
            'DOUBLE="line one\\nline two \\"quoted\\""',
            'BACK=`a b`',
            'TRAILING="value" # a comment after the quote',
            'SPACED =  spaced value  ',
          ].join('\n'),
        ),
      ),
    ).toEqual({
      SINGLE: 'a "b" # c',
      DOUBLE: 'line one\nline two "quoted"',
      BACK: 'a b',
      TRAILING: 'value',
      SPACED: 'spaced value',
    });
  });

  it('carries a double-quoted value over the lines its quote spans, and reads the next line after it', (): void => {
    expect(Object.fromEntries(parseEnvText('PEM="one\ntwo"\nNEXT=3\n'))).toEqual({
      PEM: 'one\ntwo',
      NEXT: '3',
    });
  });

  it('keeps an unclosed quote as written, a value opening on # as none, and passes over what declares nothing', (): void => {
    expect(
      Object.fromEntries(
        parseEnvText('﻿# a comment\n\nOPEN="unclosed\nHASH=#none\nnot a line\nEMPTY=\n'),
      ),
    ).toEqual({ OPEN: '"unclosed', HASH: '', EMPTY: '' });
  });

  it('prints one line a name for the sync script, and refuses a value with a line break by name only', (): void => {
    const directory = mkdtempSync(join(tmpdir(), 'day0-env-text-'));
    directories.push(directory);
    const path = join(directory, '.env.local');
    writeFileSync(path, 'A=1\nA=2\nB="x"\n', 'utf8');
    expect(envFileLines(path)).toEqual({ lines: ['A=2', 'B=x'] });
    writeFileSync(path, 'SECRET="one\\ntwo"\n', 'utf8');
    const refused = envFileLines(path);
    expect(refused).toEqual({
      refused: `SECRET in ${path} holds a line break, which no setting Day0 reads takes.`,
    });
    expect(JSON.stringify(refused)).not.toContain('one');
  });
});
