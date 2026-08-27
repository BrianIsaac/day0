import { describe, expect, it } from 'vitest';
import { plainErrorMessage } from '../../../src/lib/plain-error';

/** Exactly what a thrown Convex action reaches the browser as. */
const WRAPPED = [
  '[CONVEX A(docSources:link)] [Request ID: cf05e29a9d8cde68] Server Error',
  'Uncaught Error: the Notion documentation component is not running - add `--profile docs-notion`',
  '    at assertDocsComponentReachable (../../src/docs/components.ts:111:2)',
  '    at async handler (../../convex/docSources.ts:212:4)',
  '  Called by client',
].join('\n');

describe('the message a person reads after a backend failure', (): void => {
  it('leaves the sentence and nothing else', (): void => {
    expect(plainErrorMessage(WRAPPED)).toBe(
      'the Notion documentation component is not running - add `--profile docs-notion`',
    );
  });

  it('keeps no file path, request id or function name', (): void => {
    const plain = plainErrorMessage(WRAPPED);
    expect(plain).not.toContain('CONVEX');
    expect(plain).not.toContain('Request ID');
    expect(plain).not.toContain('.ts:');
    expect(plain).not.toContain('Called by client');
  });

  it('handles the other error classes the same way', (): void => {
    expect(
      plainErrorMessage(
        '[CONVEX M(surfaces:approve)] [Request ID: abc] Server Error\nUncaught ConvexError: Surface is not proposed.\n    at handler (../../convex/surfaces.ts:1:1)',
      ),
    ).toBe('Surface is not proposed.');
  });

  it('returns a message with no envelope untouched', (): void => {
    expect(plainErrorMessage('Failed to fetch')).toBe('Failed to fetch');
    const absent = "BROWSER_DRIVER_ABSENT: day0's browser component is not running";
    expect(plainErrorMessage(absent)).toBe(absent);
  });

  it('never returns nothing, whatever it was given', (): void => {
    expect(plainErrorMessage('Uncaught Error:')).toBe('Uncaught Error:');
    expect(plainErrorMessage('   ')).toBe('');
  });
});
