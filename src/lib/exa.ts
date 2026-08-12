import Exa from 'exa-js';
import { env } from '../env';
import { log } from './logger';

let client: Exa | null = null;

function exa(): Exa {
  if (!client) {
    client = new Exa(env.EXA_API_KEY ?? '');
  }
  return client;
}

export function isExaConfigured(): boolean {
  return !!env.EXA_API_KEY;
}

export interface ExaResult {
  title: string;
  url: string;
  text: string;
}

export interface RoleSearch {
  results: ExaResult[];
  /** True when research did not run; the caller carries on without it. */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Onboarding-time good-habits research. Mirrors `src/lib/tavily.ts`
 * `searchRole` from Protean — fixed query shape so the prompt that
 * follows is deterministic. Returns up to 8 results with full text
 * (Exa "highlights" mode is concise, "text" mode gives more context
 * for the distillation pass).
 *
 * Exa is an optional capability: no key, an exhausted credit balance or
 * a network failure all degrade to `skipped` rather than throwing, so
 * charter approval still completes on a machine with no Exa account.
 */
export async function searchRole(role: string): Promise<RoleSearch> {
  if (!env.EXA_API_KEY) {
    return { results: [], skipped: true, skipReason: 'EXA_API_KEY not set' };
  }
  const query = `What does a competent ${role} do well? Best practices, common failure modes, and professional norms.`;
  try {
    const res = await exa().search(query, {
      numResults: 8,
      type: 'auto',
      contents: {
        text: { maxCharacters: 1200 },
      },
    });
    const results = (res.results ?? []).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '(no url)',
      text: (r.text ?? '').slice(0, 1200),
    }));
    if (results.length === 0) {
      return { results, skipped: true, skipReason: 'Exa returned no results' };
    }
    return { results, skipped: false };
  } catch (err) {
    const reason = `Exa search failed: ${(err as Error).message}`;
    log.warn('exa research skipped', { role, reason });
    return { results: [], skipped: true, skipReason: reason };
  }
}

/** Test seam — lets unit tests inject a stub without hitting the network. */
export function __setExaClientForTest(stub: Exa | null): void {
  client = stub;
}
