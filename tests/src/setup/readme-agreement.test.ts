import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The two README claims a reader checks against the running stack within the
 * first hour: the criteria a work item is judged by, and the grants a deploy
 * seeds. Both are read out of the code here, so a criterion that is renamed or
 * a scope that is added cannot leave the README describing the old build - in
 * either language.
 */

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const EVALUATE = readFileSync(new URL('../../../src/work/evaluate.ts', import.meta.url), 'utf8');
const AGENTS = readFileSync(new URL('../../../convex/agents.ts', import.meta.url), 'utf8');
const DOC_SOURCES = readFileSync(new URL('../../../convex/docSources.ts', import.meta.url), 'utf8');

/** Where the Chinese half of the README starts. */
const CHINESE_HEADING = '\n## 中文说明\n';

/** The English half, and the Chinese one, as two texts. */
function halves(): { english: string; chinese: string } {
  const at = README.indexOf(CHINESE_HEADING);
  expect(at).toBeGreaterThan(0);
  return { english: README.slice(0, at), chinese: README.slice(at) };
}

/**
 * The criterion sequence the evaluator documents for itself.
 *
 * Returns:
 *   The criterion names, in the order `evaluateCandidate` applies them.
 */
function documentedCriteria(): string[] {
  const sequence = /Same criterion sequence — ([^.]+)\./.exec(EVALUATE.replace(/\n \*/g, ''));
  expect(sequence).not.toBeNull();
  return sequence![1]!
    .split(',')
    .map((name) => name.replace(/\(.*?\)/g, '').trim())
    .filter((name) => name.length > 0);
}

/** The scopes `agents:deploy` seeds in mock mode, from the code. */
function mockDeployScopes(): string[] {
  const list = /SURFACE_MODE === 'mock'\s*\?\s*\[([^\]]+)\]/.exec(AGENTS);
  expect(list).not.toBeNull();
  return [...list![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/** The English number word for a small count. */
function word(count: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][count]!;
}

/** Whether `needles` appear in `text` in this order. */
function inOrder(text: string, needles: readonly string[]): boolean {
  let at = 0;
  for (const needle of needles) {
    const found = text.indexOf(needle, at);
    if (found === -1) return false;
    at = found + needle.length;
  }
  return true;
}

describe('the work-queue criteria the README lists', (): void => {
  it('are the evaluator’s, in the evaluator’s order', (): void => {
    const criteria = documentedCriteria();
    expect(criteria).toEqual([
      'scope',
      'connection',
      'permission',
      'ownership',
      'value',
      'risk',
      'capacity',
    ]);
    const sentence = /Each candidate is[^.]+\./.exec(halves().english);
    expect(sentence).not.toBeNull();
    expect(sentence![0]).toContain(`${word(criteria.length)} criteria`);
    expect(inOrder(sentence![0], criteria)).toBe(true);
  });

  it('are the same seven in the Chinese half', (): void => {
    const chinese = ['范围', '连接', '权限', '归属', '价值', '风险', '容量'];
    const sentence = /每个候选事项[^。]+。/.exec(halves().chinese);
    expect(sentence).not.toBeNull();
    expect(sentence![0]).toContain('七项标准');
    expect(inOrder(sentence![0], chinese)).toBe(true);
  });

  it('no longer name the inputs of the one scope judgement as criteria of their own', (): void => {
    expect(README).not.toContain('eligibility, permission, ownership, quality fit');
    expect(README).not.toContain('资格、权限、归属、质量匹配');
  });
});

describe('the grants a deploy seeds', (): void => {
  it('are counted in the README as the code seeds them', (): void => {
    const scopes = mockDeployScopes();
    expect(scopes).toContain('boss:message');
    const reads = scopes.filter((scope) => scope.endsWith(':read'));
    expect(scopes).toHaveLength(6);
    expect(reads).toHaveLength(5);
    const { english, chinese } = halves();
    for (const half of [english, chinese]) {
      expect(half).not.toMatch(/five read[ -]scopes/);
      expect(half).not.toContain('五项读取范围');
    }
    expect(english).toContain(`${word(scopes.length)} grants`);
    expect(chinese).toContain('六项权限');
  });

  it('name every read the code seeds, so the five are countable', (): void => {
    for (const scope of mockDeployScopes()) {
      expect(README).toContain(`\`${scope}\``);
    }
  });
});

describe('what the company bed stores once both sources are linked', (): void => {
  it('counts the source’s own connection secret, which linking an MCP source stores', (): void => {
    // A reader who checks `npx convex data credentials` against this sentence
    // finds a fourth row: linking an MCP source stores the secret typed into
    // the form, under the source's label.
    expect(DOC_SOURCES).toContain('label: `${input.label} connection secret`');
    const { english, chinese } = halves();
    for (const half of [english, chinese]) {
      expect(half).not.toContain('are the only credentials stored');
      expect(half).not.toContain('存储的凭据只有');
    }
    expect(english).toContain('connection secret is stored beside them');
    expect(chinese).toContain('连接密钥');
  });
});
