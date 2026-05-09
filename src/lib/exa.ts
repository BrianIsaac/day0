import Exa from 'exa-js';
import { env } from '../env';

let client: Exa | null = null;

function exa(): Exa {
  if (!env.EXA_API_KEY) {
    throw new Error('EXA_API_KEY not set — cannot run good-habits research');
  }
  if (!client) {
    client = new Exa(env.EXA_API_KEY);
  }
  return client;
}

export interface ExaResult {
  title: string;
  url: string;
  text: string;
}

/**
 * Onboarding-time good-habits research. Mirrors `src/lib/tavily.ts`
 * `searchRole` from Protean — fixed query shape so the prompt that
 * follows is deterministic. Returns up to 8 results with full text
 * (Exa "highlights" mode is concise, "text" mode gives more context
 * for the GPT-5.5 distillation).
 */
export async function searchRole(role: string): Promise<ExaResult[]> {
  const query = `What does a competent ${role} do well? Best practices, common failure modes, and professional norms.`;
  const res = await exa().search(query, {
    numResults: 8,
    type: 'auto',
    contents: {
      text: { maxCharacters: 1200 },
    },
  });
  return (res.results ?? []).map((r) => ({
    title: r.title ?? '(untitled)',
    url: r.url ?? '(no url)',
    text: (r.text ?? '').slice(0, 1200),
  }));
}

/** Test seam — lets unit tests inject a stub without hitting the network. */
export function __setExaClientForTest(stub: Exa | null): void {
  client = stub;
}
