import { describe, expect, it } from 'vitest';
import { checkYuqueToken, parseYuqueLocator, yuqueLocator } from '../../../src/docs/yuque-source';

describe('a Yuque location', (): void => {
  it("is the repository's own address, on Yuque's site or a space's, whatever document was copied", (): void => {
    expect(yuqueLocator(' https://www.yuque.com/revops/runbooks ')).toBe(
      'https://www.yuque.com/revops/runbooks',
    );
    expect(yuqueLocator('https://ACME.yuque.com/revops/runbooks/close-the-quarter?view=doc')).toBe(
      'https://acme.yuque.com/revops/runbooks',
    );
    expect(parseYuqueLocator('https://acme.yuque.com/revops/runbooks')).toEqual({
      host: 'acme.yuque.com',
      group: 'revops',
      book: 'runbooks',
    });
  });

  it('is refused on any other host, over http, or with anything beyond the repository, without repeating it', (): void => {
    expect(yuqueLocator('https://example.com/revops/runbooks')).toBe(
      'https://example.com/revops/runbooks',
    );
    for (const locator of [
      'https://example.com/revops/runbooks',
      'https://yuque.com.evil.example/revops/runbooks',
      'https://yuque.com/revops/runbooks',
      'http://www.yuque.com/revops/runbooks',
      'https://www.yuque.com/revops',
      'https://www.yuque.com/revops/runbooks/close-the-quarter',
      'https://www.yuque.com/revops/runbooks?x=1',
      'https://user:pass@www.yuque.com/revops/runbooks',
      'revops/runbooks',
    ]) {
      let message = '';
      try {
        parseYuqueLocator(locator);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain("A Yuque location is a repository's address");
      expect(message).not.toContain(locator);
    }
  });
});

describe('a Yuque token', (): void => {
  it('is one line with no spaces, and a refusal never repeats it', (): void => {
    expect(() => checkYuqueToken('fixture-yuque-token')).not.toThrow();
    expect(() => checkYuqueToken('two words')).toThrow(
      'A Yuque token is one line with no spaces, as Yuque showed it.',
    );
  });
});
