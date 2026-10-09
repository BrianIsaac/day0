import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { secretLabel } from '../../../src/docs/link-input';

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
  const sequence = /Same criterion sequence(?::| \u2014) ([^.]+)\./.exec(
    EVALUATE.replace(/\n \*/g, ''),
  );
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
    expect(secretLabel({ label: 'Company handbook', kind: 'mcp' })).toBe(
      'Company handbook connection secret',
    );
    const { english, chinese } = halves();
    for (const half of [english, chinese]) {
      expect(half).not.toContain('are the only credentials stored');
      expect(half).not.toContain('存储的凭据只有');
    }
    expect(english).toContain('connection secret is stored beside them');
    expect(chinese).toContain('连接密钥');
  });
});

describe('the rollback the cloud verbs print, as the README describes it (F, C1)', (): void => {
  /** The paragraph of one half that describes the rollback. */
  function rollbackParagraph(half: string, opening: string): string {
    return half.split('\n').find((line) => line.startsWith(opening)) ?? '';
  }

  it('puts the import and the push before the promote, in the order the rollback is taken', (): void => {
    const { english, chinese } = halves();
    for (const paragraph of [
      rollbackParagraph(english, 'Setup and upgrade end with their rollback'),
      rollbackParagraph(chinese, 'setup 与 upgrade 都以回滚步骤结束'),
    ]) {
      expect(paragraph).not.toBe('');
      const importAt = paragraph.indexOf('npx convex import --replace-all');
      const promoteAt = paragraph.indexOf('vercel promote');
      expect(importAt).toBeGreaterThan(-1);
      expect(promoteAt).toBeGreaterThan(importAt);
    }
    expect(rollbackParagraph(english, 'Setup and upgrade end with their rollback')).toContain(
      'numbered in the order it is taken',
    );
    expect(rollbackParagraph(chinese, 'setup 与 upgrade 都以回滚步骤结束')).toContain(
      '按执行顺序编号',
    );
  });
});

describe('the manager address the setup writes, as the README describes it (9-U5)', (): void => {
  it('says a later address is taken on with Make it you, never that it cannot be corrected', (): void => {
    const { english, chinese } = halves();
    expect(english).not.toContain('cannot be corrected on a live agent');
    expect(chinese).not.toContain('无法在已运行的 Agent 上更正');
    expect(english).toContain(
      "your local sign-in carries it, and real mode finds your Slack DM from it; set later, each employee's People tab offers Make it you",
    );
    expect(chinese).toContain('之后再设置的话，每个员工的 People 标签页都提供 Make it you');
  });
});

describe('what a pause holds, in both halves (W12-R5, W12-R31)', (): void => {
  it('says a step under way finishes and holds before the next, never that it runs to its end', (): void => {
    const { english, chinese } = halves();
    expect(english).toContain(
      'a step already under way when the pause lands finishes the step it is on and holds before the next',
    );
    expect(english).not.toMatch(/runs to its next gate|at its next claim/);
    expect(chinese).toContain('暂停生效时已在进行中的步骤会完成当前这一步，并在下一步之前停住');
    expect(chinese).not.toContain('运行到结束');
  });

  it('says in the verbs’ help lines that queued work steps hold until unpause', (): void => {
    const { english, chinese } = halves();
    const line = (half: string, verb: string): string =>
      half.split('\n').find((text) => text.startsWith(`./setup.sh ${verb} `)) ?? '';
    expect(line(english, 'pause')).toContain('queued work steps hold until unpause');
    expect(line(english, 'unpause')).toContain('held work steps go on');
    expect(line(chinese, 'pause')).toContain('排队的工作步骤会停住');
    expect(line(chinese, 'unpause')).toContain('停住的工作步骤继续');
  });
});
