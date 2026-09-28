import { describe, expect, it } from 'vitest';
import {
  classifyStructuredFailure,
  errorInsideOk,
  itemBoundModelFailure,
  ModelRefusalError,
  ModelReplyCutError,
  moderationRefusal,
  StructuredContractError,
} from '../../../src/lib/structured-fallback';

/**
 * How a failed model call is read: whether a prompt-mode attempt is worth
 * making, whether the provider refused the content, what an error inside an
 * HTTP 200 says, and which failures belong to the work item rather than to
 * the provider's condition.
 */

const CARRIED = { requestBodyValues: { response_format: { type: 'json_schema' } } };

function apiError(fields: Record<string, unknown>, message = 'Bad Request'): Error {
  return Object.assign(new Error(message), CARRIED, fields);
}

function insideOk(body: unknown): Error {
  return apiError({ statusCode: 200, responseBody: JSON.stringify(body) }, 'Invalid JSON response');
}

describe('classifyStructuredFailure', (): void => {
  it('never tries prompt mode for a cut reply or a content refusal', (): void => {
    expect(classifyStructuredFailure(new ModelReplyCutError('day0-plan', '{"a":'))).toMatchObject({
      verdict: 'unrelated',
    });
    expect(classifyStructuredFailure(new ModelRefusalError('day0-plan', ''))).toMatchObject({
      verdict: 'unrelated',
    });
  });

  it('reads a moderation 400 in Chinese or English as the content refused, not the parameter', (): void => {
    for (const body of [
      '{"code":"DataInspectionFailed","message":"Input data may contain inappropriate content."}',
      '{"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}}',
    ]) {
      expect(classifyStructuredFailure(apiError({ statusCode: 400, responseBody: body }))).toEqual({
        verdict: 'unrelated',
        provesRefusal: false,
        evidence: 'status 400, the provider refused the content',
      });
    }
  });

  it('fails a 400 whose body rejects nothing the request carried instead of re-sending it', (): void => {
    const failure = classifyStructuredFailure(
      apiError({ statusCode: 400, responseBody: '{"error":{"message":"模型名称不存在"}}' }),
    );

    expect(failure.verdict).toBe('unrelated');
  });

  it('still tries prompt mode for a bare status or a body rejecting what the request carried', (): void => {
    expect(classifyStructuredFailure(apiError({ statusCode: 422 }))).toMatchObject({
      verdict: 'testable',
      provesRefusal: true,
    });
    expect(
      classifyStructuredFailure(
        apiError({
          statusCode: 400,
          responseBody: '{"error":{"message":"Allowed values are: text"}}',
        }),
      ),
    ).toMatchObject({ verdict: 'testable', provesRefusal: true });
  });

  it('tries prompt mode once, proving nothing, after a repeated 429 or 5xx to a request carrying response_format', (): void => {
    expect(classifyStructuredFailure(apiError({ statusCode: 429 }))).toEqual({
      verdict: 'testable',
      provesRefusal: false,
      evidence: 'repeated status 429 to a request carrying response_format',
    });
    expect(classifyStructuredFailure(apiError({ statusCode: 503 }))).toMatchObject({
      verdict: 'testable',
      provesRefusal: false,
    });
    expect(
      classifyStructuredFailure(
        Object.assign(new Error('rate limit'), { statusCode: 429, requestBodyValues: {} }),
      ),
    ).toMatchObject({ verdict: 'unrelated' });
    expect(classifyStructuredFailure(apiError({ statusCode: 401 }))).toMatchObject({
      verdict: 'unrelated',
    });
  });

  it("classes an error inside a 200 by the status its body names, not by the SDK's own words", (): void => {
    expect(
      classifyStructuredFailure(insideOk({ error: { code: 400, message: '请求参数错误' } })),
    ).toMatchObject({ verdict: 'unrelated' });
    expect(
      classifyStructuredFailure(insideOk({ error: { message: 'json_schema is not supported' } })),
    ).toMatchObject({ verdict: 'testable', provesRefusal: true });
  });
});

describe('errorInsideOk', (): void => {
  it('reads the status and message a server put inside a 200', (): void => {
    expect(errorInsideOk(insideOk({ error: { code: '503', message: 'busy' } }))).toEqual({
      status: 503,
      text: 'busy',
    });
    expect(errorInsideOk(insideOk({ status: 429, msg: 'too many' }))).toEqual({
      status: 429,
      text: 'too many',
    });
    expect(errorInsideOk(insideOk({ error: 'overloaded' }))).toEqual({ text: 'overloaded' });
  });

  it('finds it through a cause chain and ignores a 200 that carries no error', (): void => {
    expect(
      errorInsideOk(new Error('outer', { cause: insideOk({ error: { message: 'busy' } }) })),
    ).toEqual({ text: 'busy' });
    expect(errorInsideOk(insideOk({ choices: [] }))).toBeUndefined();
    expect(errorInsideOk(apiError({ statusCode: 200, responseBody: 'not json' }))).toBeUndefined();
    expect(
      errorInsideOk(apiError({ statusCode: 503, responseBody: '{"error":"busy"}' })),
    ).toBeUndefined();
  });
});

describe('moderationRefusal', (): void => {
  it("returns the provider's words for a moderation error and nothing for model output", (): void => {
    expect(
      moderationRefusal(
        apiError({
          statusCode: 400,
          responseBody: '{"error":{"message":"content_filter triggered"}}',
        }),
      ),
    ).toBe('content_filter triggered');
    expect(
      moderationRefusal(new StructuredContractError('reply says content_filter')),
    ).toBeUndefined();
    expect(moderationRefusal(new Error('content_filter, but no server answered'))).toBeUndefined();
  });
});

describe('itemBoundModelFailure', (): void => {
  it("names a failure that belongs to the item, with the provider's or model's words", (): void => {
    expect(itemBoundModelFailure(new ModelReplyCutError('day0-plan', '{'))).toBe(
      "the model's reply was cut off at the output limit",
    );
    expect(
      itemBoundModelFailure(new ModelRefusalError('day0-plan', 'I cannot help with that.')),
    ).toBe('the model provider refused the request on content grounds: I cannot help with that.');
    expect(
      itemBoundModelFailure(
        Object.assign(new StructuredContractError('no object'), { reply: 'Sorry.' }),
      ),
    ).toBe("the model's reply held no valid structured object: Sorry.");
    expect(
      itemBoundModelFailure(
        Object.assign(new StructuredContractError('did not satisfy the schema'), {
          issues: ['the plan had 9 steps; the most is 8'],
        }),
      ),
    ).toBe(
      "the model's reply held no valid structured object: the plan had 9 steps; the most is 8",
    );
    expect(
      itemBoundModelFailure(
        apiError({ statusCode: 400, responseBody: '{"error":{"message":"模型名称不存在"}}' }),
      ),
    ).toBe('the model provider rejected the request (status 400): 模型名称不存在');
    expect(itemBoundModelFailure(insideOk({ error: { code: 422, message: 'bad schema' } }))).toBe(
      'the model provider rejected the request (status 422): bad schema',
    );
  });

  it('leaves a rate limit, an outage, a bad key and a dead socket to be tried again', (): void => {
    expect(itemBoundModelFailure(apiError({ statusCode: 429 }))).toBeUndefined();
    expect(itemBoundModelFailure(apiError({ statusCode: 503 }))).toBeUndefined();
    expect(itemBoundModelFailure(apiError({ statusCode: 401 }))).toBeUndefined();
    expect(
      itemBoundModelFailure(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
    ).toBeUndefined();
    expect(itemBoundModelFailure(insideOk({ error: { message: 'busy' } }))).toBeUndefined();
  });
});

describe('what moderation is not', (): void => {
  it('leaves a rate limit or an outage that mentions moderation transient', (): void => {
    const outage = apiError({
      statusCode: 503,
      responseBody: '{"error":{"message":"moderation service unavailable"}}',
    });

    expect(moderationRefusal(outage)).toBeUndefined();
    expect(itemBoundModelFailure(outage)).toBeUndefined();
  });

  it('reads a 200 whose error field is null as no error', (): void => {
    expect(errorInsideOk(insideOk({ error: null, choices: [] }))).toBeUndefined();
  });
});
