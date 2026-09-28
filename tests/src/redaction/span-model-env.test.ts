import { describe, expect, it } from 'vitest';
import { HttpSpanModel } from '../../../src/redaction/client';
import { spanModelFromEnv } from '../../../src/redaction/span-model-env';

describe('spanModelFromEnv', (): void => {
  it('names no model when the address is unset or blank', (): void => {
    expect(spanModelFromEnv(undefined)).toBeUndefined();
    expect(spanModelFromEnv('   ')).toBeUndefined();
  });

  it('builds the HTTP span model on the trimmed address', (): void => {
    expect(spanModelFromEnv(' http://redactor:8000 ')).toBeInstanceOf(HttpSpanModel);
  });
});
