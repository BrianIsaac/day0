import { describe, expect, it } from 'vitest';
import { markdownPageTitle } from '../../../../src/docs/readers/folder';
import { underTitle } from '../../../../src/docs/readers/html-markdown';
import { holdsListedTitle, storedPageTitle } from '../../../../src/docs/readers/stored-title';
import { hashTitle } from '../../../fixtures/readers/stored';

describe('the title a page is stored under (wave 17, 17-X, the second pass)', (): void => {
  it('is the title itself where the store writes it as its source does', (): void => {
    expect(storedPageTitle('Escalation paths (2024)')).toBe('Escalation paths (2024)');
    expect(storedPageTitle('运维手册')).toBe('运维手册');
    expect(storedPageTitle('C# style guide')).toBe('C# style guide');
  });

  it('closes up the spaces of a title and drops a closing #, as the store does', (): void => {
    expect(storedPageTitle('Q3  close\tplan')).toBe('Q3 close plan');
    expect(storedPageTitle('Release notes #')).toBe('Release notes');
    expect(storedPageTitle('Q3  close plan ##')).toBe('Q3 close plan');
  });

  it.each(['Q3  close plan #', 'Runbook 7', ' Padded ', 'Tabs\tand  spaces'])(
    'is what the sync stores for a page its reader put under "%s", whatever its body',
    (title): void => {
      for (const body of ['', 'One paragraph.', '## A section\n\nText.', `# ${title}\n\nText.`]) {
        // The sync's own rule (`persistPage`): the first level-one heading of the page's Markdown.
        expect(markdownPageTitle(underTitle(title, body), title)).toBe(storedPageTitle(title));
      }
    },
  );
});

describe('whether a listed title is the one a page was stored under (wave 18, 18-X)', (): void => {
  const stored = { revision: '7', title: 'Rotate the <credential: api key, stored> key' };
  const listed = 'Rotate the vault key';

  it('holds a listed title whose keyed hash is the stored one, though the stored title is redacted', (): void => {
    expect(holdsListedTitle({ ...stored, titleHash: hashTitle(listed), hashTitle }, listed)).toBe(
      true,
    );
    // The hash is taken of the title as the store writes it, so spacing does not move it.
    expect(
      holdsListedTitle(
        { ...stored, titleHash: hashTitle(listed), hashTitle },
        'Rotate  the vault key #',
      ),
    ).toBe(true);
  });

  it('holds no renamed title, whether by its hash or by the stored title', (): void => {
    expect(
      holdsListedTitle(
        { ...stored, titleHash: hashTitle(listed), hashTitle },
        'Rotate the payroll key',
      ),
    ).toBe(false);
  });

  it('compares the stored title where no hash is stored, as before', (): void => {
    expect(holdsListedTitle(stored, listed)).toBe(false);
    expect(holdsListedTitle({ revision: '7', title: 'Q3 close plan' }, 'Q3  close plan #')).toBe(
      true,
    );
  });

  it('compares the stored title where the stored hash was taken under another key', (): void => {
    const mark = { revision: '7', title: 'Q3 close plan', titleHash: 'f'.repeat(32), hashTitle };
    expect(holdsListedTitle(mark, 'Q3 close plan')).toBe(true);
    expect(holdsListedTitle(mark, 'Q4 close plan')).toBe(false);
  });
});
