import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnvValues } from '../../../scripts/lib/env-file';
import { readEnvFile } from '../../../scripts/check-setup';

const directories: string[] = [];

afterEach((): void => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** An env file of these lines, joined by the given line break. */
function envFile(lines: readonly string[], lineBreak = '\n'): string {
  const directory = mkdtempSync(join(tmpdir(), 'day0-env-file-'));
  directories.push(directory);
  const path = join(directory, '.env.local');
  writeFileSync(path, `${lines.join(lineBreak)}${lineBreak}`, 'utf8');
  return path;
}

// W17-R24 (reader 5's probe): `.env.local` written as a shell file is written was read four ways
// by the setup's verbs, `check:setup`, `pnpm dev` and `pnpm start`, and the sync script.
describe.each([
  ['the setup verbs and the checks (readEnvValues)', readEnvValues],
  ['check:setup (readEnvFile)', readEnvFile],
])('%s, on a file written as a shell file is written (W17-R24)', (_name, read): void => {
  it('reads a single-quoted value, an inline comment and an export line as dotenv does', (): void => {
    expect(
      read(
        envFile([
          "HTTPS_PROXY='http://proxy.acme.test:3128'",
          'HTTP_PROXY=http://proxy.acme.test:3128 # corp',
          'export NO_PROXY=day0.acme.test',
          'DAY0_OIDC_CLIENT_SECRET="a#b"',
          'DAY0_APP_HOST=127.0.0.1#kept',
        ]),
      ),
    ).toMatchObject({
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      HTTP_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'day0.acme.test',
      DAY0_OIDC_CLIENT_SECRET: 'a#b',
      DAY0_APP_HOST: '127.0.0.1#kept',
    });
  });

  it('reads a CRLF file with no carriage return in any value', (): void => {
    expect(
      read(envFile(['HTTPS_PROXY=http://proxy.acme.test:3128', 'DAY0_APP_PORT=4000'], '\r\n')),
    ).toMatchObject({ HTTPS_PROXY: 'http://proxy.acme.test:3128', DAY0_APP_PORT: '4000' });
  });

  it('takes the last line of a key set twice, as compose and Next do', (): void => {
    expect(read(envFile(['DAY0_APP_PORT=4000', 'DAY0_APP_PORT=5000']))).toMatchObject({
      DAY0_APP_PORT: '5000',
    });
  });
});
