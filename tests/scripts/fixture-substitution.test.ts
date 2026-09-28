import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySubstitutions,
  isExcluded,
  MANAGER_DM_PLACEHOLDER,
  MANAGER_NAME_PLACEHOLDER,
  substitute,
} from '../../scripts/fixture-substitution';

describe('the fixture substitution rule (N15)', (): void => {
  it('replaces the recorded manager DM channel id wherever it sits, escaped JSON included', (): void => {
    expect(substitute('{"channel":"D0BS5SXMXPZ"}')).toBe(`{"channel":"${MANAGER_DM_PLACEHOLDER}"}`);
    expect(substitute('"body": "{\\"channel\\":\\"D0BS5SXMXPZ\\",\\"text\\":\\"x\\"}"')).toContain(
      `\\"channel\\":\\"${MANAGER_DM_PLACEHOLDER}\\"`,
    );
  });

  it('replaces the manager name as a whole word only, so a repository owner in a URL is untouched', (): void => {
    expect(substitute("boss: 'Brian'")).toBe(`boss: '${MANAGER_NAME_PLACEHOLDER}'`);
    expect(substitute('route it to Brain.')).toBe(`route it to ${MANAGER_NAME_PLACEHOLDER}.`);
    expect(substitute('your boss, brain')).toBe('your boss, sam');
    expect(substitute('https://github.com/BrianIsaac/day0')).toBe(
      'https://github.com/BrianIsaac/day0',
    );
    expect(substitute('Brianna signed off')).toBe('Brianna signed off');
  });

  it('replaces a full name and a handle whole, before the first name alone', (): void => {
    expect(substitute("real_name: 'Brian Isaac'")).toBe("real_name: 'Sam Ortiz'");
    expect(substitute("name: 'brian.isaac'")).toBe("name: 'sam.ortiz'");
    expect(substitute("real_name: 'Brian I'")).toBe("real_name: 'Sam O'");
  });

  it('never touches the redaction corpus, whose recorded spans are keyed by offset, nor its own test', (): void => {
    expect(isExcluded('tests/fixtures/redaction/corpus.json')).toBe(true);
    expect(isExcluded('tests/scripts/fixture-substitution.test.ts')).toBe(true);
    expect(isExcluded('tests/fixtures/work/readme-loop-plans.json')).toBe(false);
  });
});

describe('applying the rule to a tree', (): void => {
  const roots: string[] = [];
  afterEach((): void => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rewrites only the files the rule changes, and reports them; under --check it writes nothing', (): void => {
    const root = mkdtempSync(join(tmpdir(), 'day0-fixture-substitution-'));
    roots.push(root);
    mkdirSync(join(root, 'tests', 'fixtures', 'redaction'), { recursive: true });
    writeFileSync(join(root, 'tests', 'fixtures', 'a.ts'), "const dm = 'D0BS5SXMXPZ';\n");
    writeFileSync(join(root, 'tests', 'fixtures', 'b.ts'), "const dm = 'D0MANAGER';\n");
    writeFileSync(join(root, 'tests', 'fixtures', 'redaction', 'corpus.json'), '"Brian Isaac"\n');

    expect(applySubstitutions(root, { check: true }).changed).toEqual(['tests/fixtures/a.ts']);
    expect(readFileSync(join(root, 'tests', 'fixtures', 'a.ts'), 'utf8')).toContain('D0BS5SXMXPZ');

    expect(applySubstitutions(root, { check: false }).changed).toEqual(['tests/fixtures/a.ts']);
    expect(readFileSync(join(root, 'tests', 'fixtures', 'a.ts'), 'utf8')).toBe(
      `const dm = '${MANAGER_DM_PLACEHOLDER}';\n`,
    );
    expect(readFileSync(join(root, 'tests', 'fixtures', 'redaction', 'corpus.json'), 'utf8')).toBe(
      '"Brian Isaac"\n',
    );
    expect(applySubstitutions(root, { check: true }).changed).toEqual([]);
  });

  it('finds nothing left to replace in the tracked fixtures', (): void => {
    expect(applySubstitutions(resolve('.'), { check: true }).changed).toEqual([]);
  });
});
