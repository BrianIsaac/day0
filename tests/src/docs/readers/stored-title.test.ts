import { describe, expect, it } from 'vitest';
import { markdownPageTitle } from '../../../../src/docs/readers/folder';
import { underTitle } from '../../../../src/docs/readers/html-markdown';
import { storedPageTitle } from '../../../../src/docs/readers/stored-title';

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
