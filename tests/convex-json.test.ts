import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONVEX_CLI = join(ROOT, 'node_modules', 'convex', 'bin', 'main.js');

/** The repository's `convex.json`, parsed. */
function projectConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'convex.json'), 'utf8')) as Record<string, unknown>;
}

const scratch: string[] = [];

afterEach((): void => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('convex.json', (): void => {
  // N17: without it, an interactive `npx convex dev` that creates a project
  // or an anonymous deployment ran `npx --yes skills@latest add
  // get-convex/agent-skills` with no prompt and no pin (P11-5).
  it('turns the Convex AI files off', (): void => {
    expect(projectConfig().aiFiles).toEqual({ enabled: false });
  });

  // The CLI reads the file with the same defaults it uses when there is none,
  // so a key here that is not the AI files setting would change the deploy.
  it('sets nothing else a project without the file would get by default', (): void => {
    expect(Object.keys(projectConfig()).sort()).toEqual(['$schema', 'aiFiles']);
  });

  // Pins the setting to the installed CLI, so an upgrade that renames it fails
  // here rather than quietly reinstalling the tree. `CI` keeps the CLI's error
  // reporting off; `ai-files disable` makes no other request.
  it('is exactly what the installed CLI writes to disable them', (): void => {
    const project = mkdtempSync(join(tmpdir(), 'day0-convex-json-'));
    scratch.push(project);
    writeFileSync(join(project, 'package.json'), '{"name":"scratch","private":true}\n');
    execFileSync(process.execPath, [CONVEX_CLI, 'ai-files', 'disable'], {
      cwd: project,
      env: { PATH: process.env.PATH ?? '', HOME: project, CI: '1', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(JSON.parse(readFileSync(join(project, 'convex.json'), 'utf8'))).toEqual(projectConfig());
  });
});
