import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { categoryForPage } from '../../../convex/docSyncActions';
import {
  attributedUrls,
  documentedEndpoints,
  explicitlyDeniesSurface,
  surfaceDocumentation,
} from '../../../convex/orientationActions';
import { structuralSystemCandidates } from '../../../src/docs/system-discovery';
import { structuralSpans } from '../../../src/redaction/structural';
import { browserTitleMarker } from '../../../src/surfaces/browser';
import * as http from '../../../src/surfaces/http';
import { scopeCandidates } from '../../../src/surfaces/intake-scope';
import { extractManifestTemplate } from '../../../src/surfaces/slack-manifest';

/**
 * `docs/running/documentation.md` tells the person who writes the handbook
 * which shapes day0 acts on. Each example on it is read here by the function
 * that reads it in the product, so the page cannot describe a grammar the
 * code no longer has.
 */

const GUIDE = readFileSync(
  new URL('../../../docs/running/documentation.md', import.meta.url),
  'utf8',
);

/** The fenced block that follows `<!-- example: name -->` on the guide. */
function example(name: string): string {
  const found = new RegExp(
    `<!-- example: ${name} -->\\s*\`\`\`[a-z]*\\n([\\s\\S]*?)\\n\`\`\``,
  ).exec(GUIDE);
  if (!found) throw new Error(`the guide has no example "${name}"`);
  return found[1]!;
}

/** The documented-API grammar's readers, present once the HTTP rung reads a page. */
const apiGrammar = http as unknown as {
  documentedApiOperations?: (
    documentation: string,
    endpoint: string,
  ) => Array<{ method: string; operation: string }>;
  documentedCredentialHeader?: (documentation: string) => { name: string; scheme?: string };
};

/** One synced page, as orientation reads it. */
function page(ref: string, markdown: string): Doc<'docPages'> {
  return {
    _id: `page-${ref}` as Id<'docPages'>,
    _creationTime: 1,
    sourceId: 'source' as Id<'docSources'>,
    ref,
    title: /^#\s+(.+)$/m.exec(markdown)?.[1] ?? ref,
    markdown,
    updatedAt: 1,
  };
}

describe('the documentation author guide', (): void => {
  it('names systems the way discovery finds them', (): void => {
    const table = example('systems-table');
    expect(
      structuralSystemCandidates([{ ref: 'onboarding.md', title: 'Onboarding', markdown: table }])
        .map((system): string => system.name)
        .sort(),
    ).toEqual(['Linear', 'Northstar CRM']);
    const denial = example('denial');
    expect(
      structuralSystemCandidates([
        { ref: 'systems/northstar-crm.md', title: 'Northstar CRM', markdown: denial },
      ]).map((system): string => system.name),
    ).toEqual(['Northstar CRM']);
  });

  it('attributes the endpoint sentence to its system and admits the MCP endpoint', (): void => {
    const text = example('endpoint-sentence');
    const endpoints = documentedEndpoints(attributedUrls(text, 'Linear', 'linear'));
    expect(endpoints.mcp).toBe('https://mcp.linear.app/mcp');
  });

  it('reads the denial as no way in, and a later page as a way in', (): void => {
    const denial = example('denial');
    expect(explicitlyDeniesSurface(denial, 'Northstar CRM', 'Northstar CRM')).toBe(true);
    const surface = { displayName: 'Northstar CRM', slug: 'northstar-crm' };
    expect(surfaceDocumentation([page('systems/northstar-crm.md', denial)], surface).absent).toBe(
      true,
    );
    expect(
      surfaceDocumentation([page('onboarding.md', example('systems-table'))], surface).absent,
    ).toBe(false);
  });

  it('reads the probe marker', (): void => {
    expect(browserTitleMarker(example('probe-marker'))).toBe('Pipeline coverage');
  });

  it('stores the quoted credential and leaves the prose login alone', (): void => {
    const credential = example('credential');
    expect(
      structuralSpans(credential).map((span) => credential.slice(span.start, span.end)),
    ).toEqual(['pipeline-tile-local']);
    expect(structuralSpans(example('prose-login'))).toEqual([]);
    expect(structuralSpans('lin_api_XXXXXXXXXXXX')).toEqual([]);
    expect(GUIDE).toContain('`lin_api_XXXXXXXXXXXX`');
  });

  it('offers the queue lines as the card offers them', (): void => {
    const queue = [{ ref: 'finance/handbook.md', markdown: example('queue') }];
    expect(
      scopeCandidates(queue, ['team', 'project', 'channel']).map(
        (candidate): string => `${candidate.field}:${candidate.value}`,
      ),
    ).toEqual([
      'team:FIN',
      'project:September close',
      'channel:finance-close',
      'channel:ops-requests',
    ]);
  });

  it('classifies the procedure by its directory', (): void => {
    const markdown = example('procedure');
    const title = 'Q3 close checklist';
    expect(categoryForPage({ ref: 'revops/runbooks/q3-close-checklist.md', title, markdown })).toBe(
      'how-to-guide',
    );
    expect(categoryForPage({ ref: 'revops/q3-close-checklist.md', title, markdown })).toBe(
      'team-doc',
    );
  });

  it('attributes a documented API base to its system', (): void => {
    const text = example('api-operations');
    expect(documentedEndpoints(attributedUrls(text, 'Tracker', 'tracker')).api).toBe(
      'https://tracker.example.com/api/v2/',
    );
  });

  // prettier-ignore
  it.skipIf(apiGrammar.documentedApiOperations === undefined)( // skipped until the documented-API probe (wave 3 U6) lands its grammar
    'admits the documented operations, leaves the placeholder path out and finds the key header',
    (): void => {
      const text = example('api-operations');
      expect(
        apiGrammar.documentedApiOperations!(text, 'https://tracker.example.com/api/v2/'),
      ).toEqual([
        { method: 'GET', operation: 'issues' },
        { method: 'POST', operation: 'comments' },
      ]);
      expect(apiGrammar.documentedCredentialHeader!(text)).toEqual({ name: 'X-Api-Key' });
    },
  );

  it('finds the manifest block', (): void => {
    const manifest = example('manifest');
    expect(extractManifestTemplate(`# Slack app\n\n\`\`\`json\n${manifest}\n\`\`\``)).toBe(
      manifest,
    );
  });
});
