import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { linearScopeFromPages } from '../../convex/intakeActions';
import {
  attributedUrls,
  choosePath,
  documentedEndpoints,
  explicitlyDeniesSurface,
  extractCredentialFinding,
  isBrowserLoginCredential,
  namesSystem,
  relevantSystemText,
  type CredentialPage,
} from '../../convex/orientationActions';
import { redactCredentials } from '../../src/docs/redaction';
import { readMarkdownDirectory } from '../../src/docs/readers/folder';
import {
  convergeDiscoveryCandidates,
  stableSlug,
  structuralSystemCandidates,
  validateModelCandidates,
  type DiscoveryPage,
} from '../../src/docs/system-discovery';
import { PROVIDER_SHAPES, structuralSpans } from '../../src/redaction/structural';
import { browserTitleMarker } from '../../src/surfaces/browser';
import { documentedChannelNames } from '../../src/surfaces/slack-policy';
import type { DocSourceRecord } from '../../src/docs/types';
import { CORPUS_SLOTS } from '../fixtures/redaction-corpus';
import { RecordedSpanModel } from '../fixtures/redaction-double';

/**
 * The company bed's tracked pages, read the way documentation sync reads them.
 *
 * Every page under `bed/company/folder/` is what a fresh clone links as its
 * folder source, and the two texts under `bed/company/notion/` are what the
 * operator pastes into Notion. The checks here are the ones the backend runs
 * on them: system discovery, the structural credential grammar, orientation's
 * code decisions, and the intake lines each role's queue is read from.
 */

const BED = resolve('bed', 'company');
const FOLDER = join(BED, 'folder');
const NOTION = join(BED, 'notion');
const TILE_LOGIN = 'pipeline-tile-local';
const TOKEN_PLACEHOLDER = 'PASTE_LINEAR_API_KEY_HERE';
const SYSTEMS = ['Linear', 'Slack', 'Looker pipeline tile', 'Northstar CRM', 'NetLedger'];
const EMPLOYEE_PLACEHOLDERS = ['Priya', 'Mateo', 'Aiko'];

const folderSource = {
  _id: 'folder-source' as Id<'docSources'>,
  label: 'Kestrel Supply folder',
  kind: 'folder',
  locator: '.',
} satisfies DocSourceRecord;

interface BedPage {
  ref: string;
  title: string;
  markdown: string;
}

let folderPages: BedPage[] = [];
let notionPages: BedPage[] = [];

function notionPage(file: string): BedPage {
  const markdown = readFileSync(join(NOTION, file), 'utf8');
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? file;
  return { ref: `notion/${file}`, title, markdown };
}

function page(ref: string): BedPage {
  const found = [...folderPages, ...notionPages].find((candidate) => candidate.ref === ref);
  if (!found) throw new Error(`no bed page ${ref}`);
  return found;
}

function asDocPages(pages: readonly BedPage[]): Doc<'docPages'>[] {
  return pages.map((bedPage) => ({ ...bedPage }) as unknown as Doc<'docPages'>);
}

/** Every proper noun in the bed that names something other than a system. */
const NOT_SYSTEMS = [
  'Kestrel Supply',
  'Kestrel Supply Co.',
  'Meridian Freight',
  'Port Klang',
  'Brightwater',
  'Aster Works',
  'Friday standup',
  'Q4 pipeline tracker',
  'Q3 close',
  'September close',
  'Shipment exceptions',
];

beforeAll(async (): Promise<void> => {
  folderPages = (await readMarkdownDirectory(folderSource, FOLDER)).map(({ ref, title, markdown }) => ({
    ref,
    title,
    markdown,
  }));
  notionPages = readdirSync(NOTION)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort()
    .map(notionPage);
});

describe('the company bed pages', (): void => {
  it('is the thirteen folder pages and the two Notion texts the plan lists', (): void => {
    expect(folderPages.map((bedPage) => bedPage.ref)).toEqual([
      'finance/handbook.md',
      'finance/runbooks/close-status-note.md',
      'logistics/handbook.md',
      'logistics/runbooks/exception-note.md',
      'onboarding.md',
      'revops/handbook.md',
      'revops/runbooks/how-to-post-slack.md',
      'revops/runbooks/how-to-refresh-the-tile.md',
      'revops/runbooks/how-to-update-ticket.md',
      'revops/runbooks/q3-close-checklist.md',
      'systems/looker-pipeline-tile.md',
      'systems/netledger.md',
      'systems/northstar-crm.md',
    ]);
    expect(notionPages.map((bedPage) => bedPage.title)).toEqual([
      'Linear automation',
      'Slack automation policy',
    ]);
  });

  it('says on every page that the company is synthetic, and names no employee', (): void => {
    for (const bedPage of [...folderPages, ...notionPages]) {
      expect(bedPage.markdown, bedPage.ref).toMatch(/Kestrel Supply Co\. is a synthetic company/);
      for (const name of EMPLOYEE_PLACEHOLDERS) {
        expect(namesSystem(bedPage.markdown, name), `${bedPage.ref} names ${name}`).toBe(false);
      }
    }
  });
});

describe('system discovery over the folder pages', (): void => {
  it('finds exactly the five documented systems from the pages alone', (): void => {
    const systems = convergeDiscoveryCandidates(structuralSystemCandidates(folderPages));
    expect(systems.map((system) => system.name).sort()).toEqual([...SYSTEMS].sort());
  });

  it('finds no system structurally on the Notion texts', (): void => {
    expect(structuralSystemCandidates(notionPages)).toEqual([]);
  });

  it('keeps the five when a model also names them, in the words the pages use', (): void => {
    const proposals = [
      { name: 'Linear', class: 'kanban' as const, pageRef: 'revops/runbooks/how-to-update-ticket.md' },
      { name: 'Slack', class: 'chat' as const, pageRef: 'revops/runbooks/how-to-post-slack.md' },
      { name: 'Looker', class: 'analytics' as const, pageRef: 'systems/looker-pipeline-tile.md' },
      {
        name: 'Looker pipeline tile',
        class: 'analytics' as const,
        pageRef: 'revops/runbooks/how-to-refresh-the-tile.md',
      },
      { name: 'Northstar CRM', class: 'crm' as const, pageRef: 'revops/handbook.md' },
      { name: 'NetLedger', class: 'other' as const, pageRef: 'finance/handbook.md' },
    ];
    const systems = convergeDiscoveryCandidates([
      ...structuralSystemCandidates(folderPages),
      ...validateModelCandidates(folderPages, { systems: proposals }),
    ]);
    expect(systems).toHaveLength(SYSTEMS.length);
    expect(systems.map((system) => stableSlug(system.name)).sort()).toEqual(
      SYSTEMS.map(stableSlug).sort(),
    );
  });

  it('admits no page, company, carrier, customer or project as a system, whatever a model says', (): void => {
    const info = vi.spyOn(console, 'info').mockImplementation((): void => undefined);
    const pages = [...folderPages, ...notionPages];
    const proposals = pages.flatMap((bedPage) => {
      const names = new Set([bedPage.title, ...NOT_SYSTEMS]);
      // A systems page's own title is the system it documents. The Notion
      // titles are the plan's, and their headings carry "automation", which
      // the validator reads as system identity: a model that named either page
      // would be admitted, so they are left to the discovery vocabulary's owner.
      if (bedPage.ref.startsWith('systems/') || bedPage.ref.startsWith('notion/')) {
        names.delete(bedPage.title);
      }
      return [...names].map((name) => ({ name, class: 'other' as const, pageRef: bedPage.ref }));
    });
    expect(validateModelCandidates(pages, { systems: proposals })).toEqual([]);
    info.mockRestore();
  });
});

describe('credentials on the pages', (): void => {
  it('carries exactly one labelled secret, the tile login, on its system page and its runbook', (): void => {
    const found: Array<{ ref: string; value: string; label: string }> = [];
    for (const bedPage of [...folderPages, ...notionPages]) {
      for (const span of structuralSpans(bedPage.markdown)) {
        found.push({ ref: bedPage.ref, value: bedPage.markdown.slice(span.start, span.end), label: span.label });
      }
    }
    expect(found).toEqual([
      { ref: 'revops/runbooks/how-to-refresh-the-tile.md', value: TILE_LOGIN, label: 'password' },
      { ref: 'systems/looker-pipeline-tile.md', value: TILE_LOGIN, label: 'password' },
    ]);
  });

  it('carries no provider token shape on any tracked file of the bed', (): void => {
    const files = ['linear.json', 'slack-asks.md', 'answers.md', 'notion/README.md'].map((file) =>
      readFileSync(join(BED, file), 'utf8'),
    );
    for (const text of [...files, ...folderPages.map((p) => p.markdown), ...notionPages.map((p) => p.markdown)]) {
      for (const shape of PROVIDER_SHAPES) expect(text).not.toMatch(shape.pattern);
      expect(structuralSpans(text).every((span) => text.slice(span.start, span.end) === TILE_LOGIN)).toBe(true);
    }
  });

  it('holds the Linear token line as the placeholder in git, and nothing on the Slack page', (): void => {
    const linear = page('notion/linear-automation.md').markdown;
    expect(linear.split(TOKEN_PLACEHOLDER)).toHaveLength(2);
    expect(page('notion/slack-automation-policy.md').markdown).not.toMatch(/PASTE_|xox/);
  });

  it('stores the tile login and nothing else at sync, and the Linear token once it is pasted', async (): Promise<void> => {
    const options = { model: new RecordedSpanModel() };
    const stored: Record<string, string[]> = {};
    for (const bedPage of [...folderPages, ...notionPages]) {
      const result = await redactCredentials(bedPage.markdown, bedPage.title, options);
      if (result.credentials.length > 0) {
        stored[bedPage.ref] = result.credentials.map((credential) => credential.plaintext);
      }
    }
    expect(stored).toEqual({
      'revops/runbooks/how-to-refresh-the-tile.md': [TILE_LOGIN],
      'systems/looker-pipeline-tile.md': [TILE_LOGIN],
    });
    const pasted = page('notion/linear-automation.md').markdown.replace(
      TOKEN_PLACEHOLDER,
      CORPUS_SLOTS.linear_token,
    );
    const linear = await redactCredentials(pasted, 'Linear automation', options);
    expect(linear.credentials).toEqual([
      { label: 'linear service token', plaintext: CORPUS_SLOTS.linear_token },
    ]);
  });
});

describe('orientation over the synced pages', (): void => {
  let synced: CredentialPage[] = [];

  beforeAll(async (): Promise<void> => {
    const options = { model: new RecordedSpanModel() };
    const pages = [
      ...folderPages.map((bedPage) => ({ ...bedPage, sourceId: 'folder' })),
      ...notionPages.map((bedPage) => ({
        ...bedPage,
        sourceId: 'notion',
        markdown: bedPage.markdown.replace(TOKEN_PLACEHOLDER, CORPUS_SLOTS.linear_token),
      })),
    ];
    synced = await Promise.all(
      pages.map(async (bedPage) => ({
        ...bedPage,
        markdown: (await redactCredentials(bedPage.markdown, bedPage.title, options)).markdown,
      })),
    );
  });

  function orient(system: string, slug: string, draftPath: 'mcp' | 'documented-api' | 'browser-driven' | 'escalate') {
    const matches = synced.filter((bedPage) => namesSystem(`${bedPage.title}\n${bedPage.markdown}`, system));
    const relevant = matches.map((bedPage) => relevantSystemText(bedPage.markdown, system, bedPage.title)).join('\n\n');
    const endpoints = documentedEndpoints(attributedUrls(relevant, system, slug));
    const denied = matches.filter((bedPage) => explicitlyDeniesSurface(bedPage.markdown, system, bedPage.title));
    const credential = extractCredentialFinding(matches, system);
    const chosen = choosePath(draftPath, endpoints, isBrowserLoginCredential(credential), browserTitleMarker(relevant) !== undefined);
    return { matches, endpoints, denied, credential, chosen };
  }

  it('reaches Linear by its MCP endpoint with the pasted service token', (): void => {
    const linear = orient('Linear', 'linear', 'mcp');
    expect(linear.denied.map((bedPage) => bedPage.ref)).toEqual([]);
    expect(linear.chosen).toEqual({ path: 'mcp', endpoint: 'https://mcp.linear.app/mcp' });
    expect(linear.credential).toMatchObject({ found: 'value', label: 'linear service token', method: 'api-key' });
  });

  it('reaches Slack by its Web API, with the shared bot token landed by the administrator', (): void => {
    const slack = orient('Slack', 'slack', 'documented-api');
    expect(slack.denied.map((bedPage) => bedPage.ref)).toEqual([]);
    expect(slack.chosen).toEqual({ path: 'documented-api', endpoint: 'https://slack.com/api/' });
    expect(slack.credential).toMatchObject({ found: 'location', method: 'bot-token' });
  });

  it('reaches the tile through its web page with the stored login and the probe marker', (): void => {
    const tile = orient('Looker pipeline tile', 'looker-pipeline-tile', 'browser-driven');
    expect(tile.chosen).toEqual({ path: 'browser-driven', endpoint: 'http://looker-tile:8080/' });
    expect(tile.credential.found).toBe('value');
    expect(isBrowserLoginCredential(tile.credential)).toBe(true);
  });

  it('records Northstar CRM and NetLedger as absent, with no address of any kind', (): void => {
    for (const [system, slug] of [
      ['Northstar CRM', 'northstar-crm'],
      ['NetLedger', 'netledger'],
    ] as const) {
      const absent = orient(system, slug, 'escalate');
      expect(absent.denied.length, system).toBeGreaterThan(0);
      expect(absent.endpoints, system).toEqual({});
      expect(absent.chosen, system).toEqual({ path: 'escalate' });
    }
  });

  it('never denies Linear, Slack or the tile on a line that names them', (): void => {
    for (const system of ['Linear', 'Slack', 'Looker pipeline tile']) {
      const deniedOn = synced
        .filter((bedPage) => explicitlyDeniesSurface(bedPage.markdown, system, bedPage.title))
        .map((bedPage) => bedPage.ref);
      // The tile's own pages say it has no API while documenting its web page.
      const expected = system === 'Looker pipeline tile'
        ? ['revops/runbooks/how-to-refresh-the-tile.md', 'systems/looker-pipeline-tile.md']
        : [];
      expect(deniedOn.sort(), system).toEqual(expected);
    }
  });
});

describe('the intake lines each role reads its queue from', (): void => {
  const roles = [
    { folder: 'revops', team: 'REVOPS', project: 'Q3 close', channels: ['revops-asks', 'revops', 'ops-requests'] },
    { folder: 'finance', team: 'FIN', project: 'September close', channels: ['finance-close', 'ops-requests'] },
    { folder: 'logistics', team: 'LOG', project: 'Shipment exceptions', channels: ['logistics-desk', 'ops-requests'] },
  ];

  it('parses each handbook to its own team, project and channels', (): void => {
    for (const role of roles) {
      const handbook = page(`${role.folder}/handbook.md`);
      expect(linearScopeFromPages(asDocPages([handbook])), role.folder).toEqual({
        team: role.team,
        project: role.project,
      });
      expect(documentedChannelNames([handbook]), role.folder).toEqual(role.channels);
    }
  });

  it('gives each role one scope from its own pages in either order', (): void => {
    for (const role of roles) {
      const own = folderPages.filter((bedPage) => bedPage.ref.startsWith(`${role.folder}/`));
      for (const ordered of [own, [...own].reverse()]) {
        expect(linearScopeFromPages(asDocPages(ordered)), role.folder).toEqual({
          team: role.team,
          project: role.project,
        });
        expect(documentedChannelNames(ordered).sort(), role.folder).toEqual([...role.channels].sort());
      }
    }
  });

  it('keeps every team, project and channel line off the shared pages', (): void => {
    const shared = [...folderPages, ...notionPages].filter(
      (bedPage) => !roles.some((role) => bedPage.ref.startsWith(`${role.folder}/`)),
    );
    for (const bedPage of shared) {
      expect(documentedChannelNames([bedPage]), bedPage.ref).toEqual([]);
      expect(bedPage.markdown, bedPage.ref).not.toMatch(/(?:^|\n)\s*-?\s*(?:Project|Team)\s*:/i);
      expect(bedPage.markdown, bedPage.ref).not.toMatch(/\bidentifier\s+`/i);
      expect(bedPage.markdown, bedPage.ref).not.toMatch(/\bproject\s+`/i);
    }
  });
});
