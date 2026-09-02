import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppliedAction } from '../../../src/surfaces/types';
import type { MockSurfaceSnapshot } from '../../../src/work/types';

function response(output: unknown[], id: string): Response {
  return new Response(
    JSON.stringify({
      id,
      created_at: 1_788_342_400,
      model: 'gpt-5.6-terra',
      output,
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function snapshot(): MockSurfaceSnapshot {
  return {
    spreadsheets: [],
    slackChannels: [],
    tweets: [],
    tickets: [],
    teamDocs: [{ slug: 'team', title: 'Team guide', body: 'The trivial answer is documented.' }],
    howToGuides: [],
  } as unknown as MockSurfaceSnapshot;
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ordinary-agent hosted provider boundary', (): void => {
  it('sends the real five-tool loop through Responses and accepts a tool round trip', async (): Promise<void> => {
    vi.resetModules();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('OPENAI_MODEL', 'gpt-5.6-terra');
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url, body });
        if (requests.length === 1) {
          return response(
            [
              {
                type: 'function_call',
                id: 'fc_docs',
                call_id: 'call_docs',
                name: 'docs_lookup',
                arguments: '{"query":"team guide"}',
              },
            ],
            'resp_tool',
          );
        }
        return response(
          [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_done',
              content: [
                {
                  type: 'output_text',
                  text: 'Done.',
                  annotations: [],
                  logprobs: null,
                },
              ],
            },
          ],
          'resp_done',
        );
      }),
    );

    const { runBaselineAgent } = await import('../../../src/evaluation/baseline-agent');
    let toolCalls = 0;
    const result = await runBaselineAgent({
      candidate: {
        id: 'work-provider',
        sourceSystem: 'linear',
        sourceCategory: 'issue',
        externalId: 'PROBE-1',
        title: 'Check the team guide',
        contentSummary: 'Look up the team guide and report completion.',
        contentRefs: [],
      },
      snapshot: snapshot(),
      invokeAction: async (): Promise<AppliedAction> => {
        throw new Error('the probe should only use docs.lookup');
      },
      onToolCall: () => {
        toolCalls += 1;
      },
    });

    expect(result.draft).toBe('Done.');
    expect(toolCalls).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url === 'https://api.openai.com/v1/responses')).toBe(true);
    expect(requests[0]?.body).not.toHaveProperty('reasoning');
    expect(requests[0]?.body).not.toHaveProperty('reasoning_effort');
    expect(
      (requests[0]?.body.tools as Array<{ name: string }>).map(({ name }) => name).sort(),
    ).toEqual([
      'docs_lookup',
      'slack_postMessage',
      'spreadsheet_appendRow',
      'ticket_update',
      'twitter_reply',
    ]);
    expect(requests[1]?.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_docs' }),
      ]),
    );
  });
});
