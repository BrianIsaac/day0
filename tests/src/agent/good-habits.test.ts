import { describe, expect, it } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import type { RoleSearch } from '../../../src/lib/exa';
import { researchAndDistil, type GoodHabitsSources } from '../../../src/agent/good-habits';

const FOUND: RoleSearch = {
  results: [
    {
      title: 'What good RevOps analysts do',
      url: 'https://example.com/revops',
      text: 'Confirm scope before estimating.',
    },
  ],
  skipped: false,
};

/**
 * Sources whose search finds one page and whose model call answers with `reply`.
 *
 * @param reply - Stands in for the provider's generate call, so it resolves or rejects as the provider would.
 */
function sources(reply: () => Promise<unknown>): GoodHabitsSources {
  const agent = { name: 'day0-good-habits', generate: reply } as unknown as Agent;
  return { search: async (): Promise<RoleSearch> => FOUND, agent };
}

describe('good-habits research', (): void => {
  it('distils the found pages into a fragment when the model finishes', async (): Promise<void> => {
    const fragment =
      '## Good-habits memory (role: RevOps analyst)\n\n- Confirm scope before estimating. (https://example.com/revops)';
    const result = await researchAndDistil(
      'RevOps analyst',
      sources(async () => ({ text: fragment, finishReason: 'stop' })),
    );
    expect(result).toEqual({ fragment, results: FOUND.results, norms: 1, skipped: false });
  });

  it('skips with the reason when the reply was cut at the output limit', async (): Promise<void> => {
    const result = await researchAndDistil(
      'RevOps analyst',
      sources(async () => ({
        text: '## Good-habits memory (role: RevOps analyst)\n\n- Confirm',
        finishReason: 'length',
      })),
    );
    expect(result).toMatchObject({ fragment: '', norms: 0, skipped: true });
    expect(result.skipReason).toBe(
      "good-habits distillation failed: day0-good-habits: the model's reply was cut off at the output limit",
    );
  });

  it('skips with the reason when the provider filtered the reply', async (): Promise<void> => {
    const result = await researchAndDistil(
      'RevOps analyst',
      sources(async () => ({ text: '', finishReason: 'content-filter' })),
    );
    expect(result).toMatchObject({ fragment: '', norms: 0, skipped: true });
    expect(result.skipReason).toBe(
      'good-habits distillation failed: day0-good-habits: the model provider refused the request on content grounds',
    );
  });

  it('skips with the reason when the model call itself fails', async (): Promise<void> => {
    const result = await researchAndDistil(
      'RevOps analyst',
      sources(async () => {
        throw Object.assign(new Error('Incorrect API key provided'), { statusCode: 401 });
      }),
    );
    expect(result).toMatchObject({ fragment: '', norms: 0, skipped: true });
    expect(result.skipReason).toBe('good-habits distillation failed: Incorrect API key provided');
  });
});
