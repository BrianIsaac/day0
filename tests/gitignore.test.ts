import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Whether the suite runs inside a git work tree; a source archive has none to ask. */
const IN_WORK_TREE =
  spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout?.trim() === 'true';

/** Whether the ignore rules alone, not the index, exclude a path. */
function ignored(path: string): boolean {
  return (
    spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: ROOT }).status === 0
  );
}

/** The tracked files under the given paths. */
function tracked(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line: string): boolean => line !== '');
}

// Q8 and N17: the vendored agent skills and the CLI state that reinstalls them
// stay on disk for whoever uses them and out of the public tree.
describe('.gitignore', (): void => {
  it.skipIf(!IN_WORK_TREE)(
    'keeps the agent skills, their lock and the CLI state file out of the tree (needs git)',
    (): void => {
      expect(ignored('skills/convex/SKILL.md')).toBe(true);
      expect(ignored('skills-lock.json')).toBe(true);
      expect(ignored('convex/_generated/ai/ai-files.state.json')).toBe(true);
      expect(
        tracked('skills', 'skills-lock.json', 'convex/_generated/ai/ai-files.state.json'),
      ).toEqual([]);
    },
  );

  it.skipIf(!IN_WORK_TREE)(
    "leaves the product's own skills code and generated API tracked (needs git)",
    (): void => {
      for (const path of [
        'convex/skills.ts',
        '.github/images/skills-registered.webp',
        'tests/convex/skills.test.ts',
        'convex/_generated/api.d.ts',
      ]) {
        expect(ignored(path)).toBe(false);
      }
    },
  );
});
