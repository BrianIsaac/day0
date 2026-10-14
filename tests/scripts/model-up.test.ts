import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/model-up.ts');
const TSX = resolve('node_modules/.bin/tsx');
const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('pnpm model:up', (): void => {
  it('refuses a service the GPU overlay reserves no device for, before it runs docker', (): void => {
    // A stand-in docker first on PATH leaves a mark if the script ever reaches it.
    const bin = mkdtempSync(join(tmpdir(), 'model-up-bin-'));
    created.push(bin);
    const mark = join(bin, 'docker-was-called');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\ntouch "${mark}"\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const result = spawnSync(TSX, [SCRIPT, 'backend'], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '"backend" is not a service docker-compose.gpu.yml reserves a device for: model, redactor.',
    );
    expect(existsSync(mark)).toBe(false);
  });

  // D-9 (a): `pnpm model:up` and `pnpm redactor:up` start their service with `docker compose up`,
  // which fills `${HTTPS_PROXY}` from the shell before the env file; run by hand from a shell
  // that exports a proxy, the redactor took that proxy while the deployment followed the file.
  it('starts compose with the env file’s proxy alone, never the shell’s', (): void => {
    const checkout = mkdtempSync(join(tmpdir(), 'model-up-checkout-'));
    created.push(checkout);
    const seen = join(checkout, 'seen');
    writeFileSync(
      join(checkout, 'docker'),
      `#!/bin/sh\necho "$*|$HTTPS_PROXY|$NO_PROXY" >> "${seen}"\n`,
    );
    chmodSync(join(checkout, 'docker'), 0o755);
    const run = (envText: string): string[] => {
      writeFileSync(join(checkout, '.env.local'), envText, 'utf8');
      rmSync(seen, { force: true });
      spawnSync(TSX, [SCRIPT, 'redactor'], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          NODE_ENV: 'test',
          MODEL_GPU: 'off',
          HTTPS_PROXY: 'http://corp-proxy.acme.test:8080',
          NO_PROXY: 'intranet.acme.test',
          PATH: `${checkout}${delimiter}${process.env.PATH ?? ''}`,
        },
        timeout: 60_000,
      });
      return readFileSync(seen, 'utf8').trim().split('\n');
    };
    const direct = run('');
    expect(direct[0]).toMatch(/ up -d redactor\|\|$/);
    const proxied = run('HTTPS_PROXY=http://proxy.acme.test:3128\nNO_PROXY=day0.acme.test\n');
    expect(proxied[0]).toMatch(
      / up -d redactor\|http:\/\/proxy\.acme\.test:3128\|day0\.acme\.test$/,
    );
  });
});
