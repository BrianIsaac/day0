import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveAppPort } from '../../scripts/dev';

describe('the port pnpm dev serves on', (): void => {
  it('takes the shell, then the file, then 3000', (): void => {
    expect(resolveAppPort('45300', 'DAY0_APP_PORT=4000\n')).toBe('45300');
    expect(resolveAppPort('', 'DAY0_APP_PORT=4000\n')).toBe('4000');
    expect(resolveAppPort(undefined, 'DAY0_APP_PORT="4000"\n')).toBe('4000');
    expect(resolveAppPort(undefined, 'DAY0_APP_PORT=\n')).toBe('3000');
    expect(resolveAppPort(undefined, undefined)).toBe('3000');
  });

  it('is what package.json runs for pnpm dev, so the URL and the server agree', (): void => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts.dev).toBe('tsx scripts/dev.ts');
    const source = readFileSync('scripts/dev.ts', 'utf8');
    expect(source).toContain("['scripts/dev-no-auth-key.ts', 'url']");
    expect(source).toContain("['dev', '-H', 'localhost', '-p', port]");
  });
});
