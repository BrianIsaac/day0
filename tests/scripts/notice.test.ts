import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LICENCE_TEXTS,
  PACKAGE_EXCEPTIONS,
  collectNoticeInput,
  composePins,
  copyrightLine,
  installedLibvipsComponents,
  libvipsRelease,
  lockedLibvips,
  productionGraph,
  renderNotice,
  type NoticeInput,
} from '../../scripts/notice';
import { temporaryDirectories } from '../setup/temporary-directories';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const temporaryDirectory = temporaryDirectories();

/** The components sharp-libvips 1.2.4's versions.json lists, as the installed package states them. */
const LIBVIPS_COMPONENTS: Readonly<Record<string, string>> = {
  aom: '3.13.1',
  archive: '3.8.2',
  cairo: '1.18.4',
  cgif: '0.5.0',
  exif: '0.6.25',
  expat: '2.7.3',
  ffi: '3.5.2',
  fontconfig: '2.17.1',
  freetype: '2.14.1',
  fribidi: '1.0.16',
  glib: '2.86.1',
  harfbuzz: '12.1.0',
  heif: '1.20.2',
  highway: '1.3.0',
  imagequant: '2.4.1',
  lcms: '2.17',
  mozjpeg: '0826579',
  pango: '1.57.0',
  pixman: '0.46.4',
  png: '1.6.50',
  'proxy-libintl': '0.5',
  rsvg: '2.61.2',
  spng: '0.7.4',
  tiff: '4.7.1',
  vips: '8.17.3',
  webp: '1.6.0',
  xml2: '2.15.1',
  'zlib-ng': '2.2.5',
};

/** A small input with one of everything the renderer groups. */
function input(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return {
    runtime: [
      {
        name: 'next',
        version: '16.2.6',
        licence: 'MIT',
        holder: 'Copyright (c) 2025 Vercel, Inc.',
        licenceFile: true,
      },
      {
        name: '@mastra/core',
        version: '1.32.1',
        licence: 'Apache-2.0',
        holder: 'holder not stated by the package',
        licenceFile: false,
      },
    ],
    development: [
      {
        name: 'vitest',
        version: '4.1.11',
        licence: 'MIT',
        holder: 'VoidZero Inc.',
        licenceFile: true,
      },
    ],
    transitive: [
      {
        name: 'tar',
        version: '7.5.15',
        licence: 'BlueOak-1.0.0',
        holder: 'Isaac Z. Schlueter',
        licenceFile: true,
      },
      {
        name: 'caniuse-lite',
        version: '1.0.1',
        licence: 'CC-BY-4.0',
        holder: 'Ben Briggs',
        licenceFile: true,
      },
      {
        name: 'import-in-the-middle',
        version: '2.0.6',
        licence: 'Apache-2.0',
        holder: 'Bryan English',
        licenceFile: true,
        notice: 'This product includes software developed at Datadog (https://www.datadoghq.com/).',
      },
      {
        name: 'json-schema',
        version: '0.4.0',
        licence: '(AFL-2.1 OR BSD-3-Clause)',
        holder: 'The Dojo Foundation',
        licenceFile: true,
      },
    ],
    libvips: ['@img/sharp-libvips-linux-x64@1.2.4'],
    libvipsComponents: LIBVIPS_COMPONENTS,
    pins: {
      notionMcpServer: '2.5.1',
      redactorModel: 'urchade/gliner_multi_pii-v1',
      localModel: 'qwen3:8b',
      libvipsRelease: '1.2.4',
    },
    proteanFiles: ['src/work/plan.ts'],
    texts: Object.fromEntries(LICENCE_TEXTS.map((name) => [name, `text of ${name}\n`])),
    ...overrides,
  };
}

describe('the tracked NOTICE', () => {
  it('is what scripts/notice.ts generates from this tree, so it cannot drift', () => {
    const tracked = readFileSync(new URL('../../NOTICE', import.meta.url), 'utf8');
    expect(tracked).toBe(renderNotice(collectNoticeInput(ROOT)));
  });

  it('carries the credits decision N6 promised and the backend licence A15 records', () => {
    const tracked = readFileSync(new URL('../../NOTICE', import.meta.url), 'utf8');
    for (const credit of [
      'urchade/gliner_multi_pii-v1',
      'Zaratiana',
      'microsoft/mdeberta-v3-base',
      '@notionhq/notion-mcp-server',
      'mcr.microsoft.com/playwright/mcp',
      'ollama/ollama',
      'Qwen3',
      'Singapore Codex Pets',
      'FSL-1.1-ALv2',
      'GNU LESSER GENERAL PUBLIC LICENSE',
      'Mozilla Public License Version 2.0',
      'Copyright 2021 Datadog, Inc.',
    ]) {
      expect(tracked, credit).toContain(credit);
    }
  });
});

describe('renderNotice', () => {
  const text = renderNotice(input());

  it('lists each direct dependency with its licence and holder, and says when the package ships no licence file', () => {
    expect(text).toContain('- next 16.2.6: MIT, Copyright (c) 2025 Vercel, Inc.\n');
    expect(text).toContain(
      '- @mastra/core 1.32.1: Apache-2.0, holder not stated by the package (no licence file in the package; from its manifest)',
    );
    expect(text).toContain('- vitest 4.1.11: MIT, VoidZero Inc.');
  });

  it('groups the transitive notice duties and reproduces a NOTICE verbatim', () => {
    expect(text).toContain(
      'Blue Oak Model License 1.0.0 (https://blueoakcouncil.org/license/1.0.0):\n\n- tar 7.5.15',
    );
    expect(text).toContain('- caniuse-lite 1.0.1: CC-BY-4.0, Ben Briggs');
    expect(text).toContain(
      '    This product includes software developed at Datadog (https://www.datadoghq.com/).',
    );
    expect(text).toContain('- json-schema 0.4.0: (AFL-2.1 OR BSD-3-Clause), The Dojo Foundation');
    expect(text).toContain('- @img/sharp-libvips-linux-x64@1.2.4');
  });

  it('names the adapted files and appends every licence text', () => {
    expect(text).toContain('- src/work/plan.ts');
    expect(text).toContain(
      "Protean, the maintainer's own earlier codebase, under the same holder\nand licence:",
    );
    for (const name of LICENCE_TEXTS) expect(text).toContain(`text of ${name}`);
  });

  it('credits the versions and models its pins name, not ones typed into the script', () => {
    const moved = renderNotice(
      input({
        pins: {
          notionMcpServer: '9.9.9',
          redactorModel: 'urchade/gliner_multi_pii-v1',
          localModel: 'qwen3:14b',
          libvipsRelease: '9.8.7',
        },
      }),
    );
    expect(moved).toContain('@notionhq/notion-mcp-server 9.9.9');
    expect(moved).toContain('The libvips binaries of sharp-libvips 9.8.7');
    expect(moved).toContain('Qwen3 (qwen3:14b through Ollama');
    expect(moved).not.toContain('2.5.1');
    expect(moved).not.toContain('qwen3:8b');
  });

  it('lists each bundled libvips component at the version its release states, under its licence', () => {
    const text = renderNotice(
      input({ libvipsComponents: { ...LIBVIPS_COMPONENTS, vips: '8.18.0', aom: '3.14.0' } }),
    );
    expect(text).toContain('libvips 8.18.0');
    expect(text).toContain(
      '  BSD-2-Clause and the Alliance for Open Media Patent License 1.0: aom 3.14.0',
    );
    expect(text).toContain('libnsgif (in libvips)');
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(200);
  });

  it('refuses a libvips release whose components its licence table does not match', () => {
    expect(() =>
      renderNotice(input({ libvipsComponents: { ...LIBVIPS_COMPONENTS, jxl: '0.11.1' } })),
    ).toThrow(/new: jxl; gone: none/);
    const withoutAom = Object.fromEntries(
      Object.entries(LIBVIPS_COMPONENTS).filter(([component]) => component !== 'aom'),
    );
    expect(() => renderNotice(input({ libvipsComponents: withoutAom }))).toThrow(
      /new: none; gone: aom/,
    );
  });

  it('says what a direct dependency ships outside its manifest licence', () => {
    expect(renderNotice(input())).toContain(
      '  its auth/ee entry point is marked in its source as under the Mastra',
    );
  });

  it('names every source it is generated from in its header', () => {
    const text = renderNotice(input());
    for (const source of [
      'package.json',
      'pnpm-lock.yaml',
      'docker-compose.yml',
      'scripts/models.ts',
    ]) {
      expect(text.slice(0, text.indexOf('1. Works'))).toContain(source);
    }
  });

  it('refuses a model it has no credit for, so the gate fails until one is written', () => {
    const pins = input().pins;
    expect(() => renderNotice(input({ pins: { ...pins, redactorModel: 'acme/pii' } }))).toThrow(
      /redactor model acme\/pii/,
    );
    expect(() => renderNotice(input({ pins: { ...pins, localModel: 'llama3:8b' } }))).toThrow(
      /local model llama3:8b/,
    );
  });

  it('ends with one newline', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});

describe('copyrightLine', () => {
  it('skips the Apache template placeholder and the licence body', () => {
    expect(
      copyrightLine(
        '      copyright notice that is included in or attached to the work\n' +
          '   Copyright [yyyy] [name of copyright owner]\n' +
          '   Copyright 2026 Convex, Inc.\n',
      ),
    ).toBe('Copyright 2026 Convex, Inc.');
  });

  it('finds no holder in a text that states none', () => {
    expect(copyrightLine('Apache License\nVersion 2.0, January 2004\n')).toBeUndefined();
  });
});

describe('lockedLibvips', () => {
  it('reads every platform binary the lockfile resolves, not only the installed ones', () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@img/sharp-libvips-linux-x64@1.2.4':",
      '    resolution: {integrity: sha512-a}',
      "  '@img/sharp-libvips-darwin-arm64@1.2.4':",
      '    resolution: {integrity: sha512-b}',
      "  '@img/sharp-linux-x64@0.34.5':",
      '    resolution: {integrity: sha512-c}',
      "  '@img/sharp-win32-x64@0.34.5':",
      '    resolution: {integrity: sha512-d}',
      "  '@img/sharp-wasm32@0.34.5':",
      '    resolution: {integrity: sha512-e}',
    ].join('\n');
    expect(lockedLibvips(lockfile)).toEqual([
      '@img/sharp-libvips-darwin-arm64@1.2.4',
      '@img/sharp-libvips-linux-x64@1.2.4',
      '@img/sharp-wasm32@0.34.5',
      '@img/sharp-win32-x64@0.34.5',
    ]);
  });
});

describe('libvipsRelease', () => {
  it('reads the one sharp-libvips release, ignoring the sharp builds that bundle it', () => {
    expect(
      libvipsRelease([
        '@img/sharp-libvips-darwin-arm64@1.2.4',
        '@img/sharp-libvips-linux-x64@1.2.4',
        '@img/sharp-win32-x64@0.34.5',
      ]),
    ).toBe('1.2.4');
  });

  it('refuses a lockfile resolving two releases, since NOTICE lists one release', () => {
    expect(() =>
      libvipsRelease([
        '@img/sharp-libvips-darwin-arm64@1.2.4',
        '@img/sharp-libvips-linux-x64@1.3.0',
      ]),
    ).toThrow(/1\.2\.4, 1\.3\.0/);
  });
});

describe('composePins', () => {
  it('reads the Notion server pin and the redactor model from the compose file', () => {
    const compose = [
      '      - REDACTOR_MODEL=${REDACTOR_MODEL:-urchade/gliner_multi_pii-v1}',
      "        'exec npx -y @notionhq/notion-mcp-server@2.6.0 --transport http',",
    ].join('\n');
    expect(composePins(compose)).toEqual({
      notionMcpServer: '2.6.0',
      redactorModel: 'urchade/gliner_multi_pii-v1',
    });
  });

  it('refuses a compose file that no longer pins either', () => {
    expect(() => composePins('services: {}\n')).toThrow(/no longer pins/);
  });
});

describe('installedLibvipsComponents', () => {
  it("reads the components and versions of the installed package of the lockfile's release", () => {
    const directory = temporaryDirectory('day0-notice-');
    const libvips = join(directory, 'sharp-libvips-linux-x64');
    mkdirSync(libvips);
    writeFileSync(
      join(libvips, 'versions.json'),
      JSON.stringify({ vips: '8.17.3', aom: '3.13.1' }),
    );
    const graph = new Map([
      ['@img/sharp-libvips-linux-x64@1.2.4', libvips],
      ['next@16.2.6', directory],
    ]);
    expect(installedLibvipsComponents(graph, '1.2.4')).toEqual({ aom: '3.13.1', vips: '8.17.3' });
    expect(() => installedLibvipsComponents(graph, '1.3.0')).toThrow(
      /1\.3\.0 package is installed/,
    );
  });
});

describe('the parts of a dependency NOTICE says Day0 does not use', () => {
  it('are imported nowhere in the tree', () => {
    const sources = ['app', 'convex', 'src', 'scripts'].flatMap((top) =>
      (readdirSync(join(ROOT, top), { recursive: true, withFileTypes: true }) as Dirent[])
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    for (const { entry } of Object.values(PACKAGE_EXCEPTIONS)) {
      const imports = new RegExp(
        `(?:from|import\\()\\s*['"]${entry.replace(/[/.]/g, '\\$&')}['"/]`,
      );
      const importers = sources.filter((path) => imports.test(readFileSync(path, 'utf8')));
      expect(importers, entry).toEqual([]);
    }
  });
});

describe('productionGraph', () => {
  it('walks the runtime dependencies transitively and leaves development ones out', () => {
    const graph = productionGraph(ROOT);
    const names = [...graph.keys()].map((key) => key.replace(/@[^@]+$/, ''));
    expect(names).toContain('next');
    expect(names).toContain('caniuse-lite');
    expect(names).toContain('tar');
    expect(names).not.toContain('vitest');
  });
});
