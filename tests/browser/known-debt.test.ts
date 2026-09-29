import { describe, expect, it } from 'vitest';
import { beyondDebt, debtKeys, unmetDebt, type Debt } from './known-debt';

const FOOTER = {
  reason: "the landing footer's links (app/marketing)",
  axe: ['scrollable-region-focusable #run > div > pre'],
  targets: ['a "GitHub" at footer > ul > li:nth-of-type(1) > a'],
} as const satisfies Debt;

describe('the browser job’s known debt (M4)', (): void => {
  it('covers only the node a debt names, so a second node of a known rule still fails', (): void => {
    const known = debtKeys([FOOTER], 'desktop', 'axe');
    const found = [
      'scrollable-region-focusable #run > div > pre',
      'scrollable-region-focusable #ways > div:nth-of-type(2) > pre',
    ];
    expect(beyondDebt(known, found)).toEqual([
      'scrollable-region-focusable #ways > div:nth-of-type(2) > pre',
    ]);
  });

  it('covers only the control a debt names, so a second control of a known name still fails', (): void => {
    const known = debtKeys([FOOTER], 'phone', 'targets');
    const found = [
      'a "GitHub" at footer > ul > li:nth-of-type(1) > a',
      'a "GitHub" at #main > header > nav > a',
    ];
    expect(beyondDebt(known, found)).toEqual(['a "GitHub" at #main > header > nav > a']);
  });

  it('names a debt the page no longer carries, so its entry leaves with the fix (M5)', (): void => {
    const known = debtKeys([FOOTER], 'desktop', 'targets');
    expect(unmetDebt(known, [])).toEqual(['a "GitHub" at footer > ul > li:nth-of-type(1) > a']);
  });

  it('holds a debt to the project it shows under', (): void => {
    const phoneOnly: Debt = { ...FOOTER, project: 'phone' };
    expect(debtKeys([phoneOnly], 'desktop', 'axe')).toEqual([]);
    expect(debtKeys([phoneOnly], 'phone', 'axe').map((debt) => debt.key)).toEqual(FOOTER.axe);
  });
});
