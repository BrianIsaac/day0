import { describe, expect, it } from 'vitest';
import HomeAddressPage from '../../../app/home/page';

describe('the /home address (round 0141 R-D item 4)', (): void => {
  it("sends a manager signed in through /home to Day0's home, where the employees are", (): void => {
    let thrown: unknown;
    try {
      HomeAddressPage();
    } catch (err: unknown) {
      thrown = err;
    }
    // Next's redirect is thrown as an error whose digest names the target: NEXT_REDIRECT;<type>;<url>;<status>.
    const digest = (thrown as { digest?: unknown } | undefined)?.digest;
    expect(typeof digest === 'string' ? digest.split(';').slice(0, 3) : digest).toEqual([
      'NEXT_REDIRECT',
      'replace',
      '/',
    ]);
  });
});
