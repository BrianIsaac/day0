import { describe, expect, it } from 'vitest';
import { transferNoticeText } from '../../convex/transferNotice';

describe('transferNoticeText', (): void => {
  it('says who asks, for whom, where to answer and that nothing changes until they do', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Maya',
        fromAddress: 'sam@company.com',
        publicUrl: 'https://day0.company.com/',
      }),
    ).toBe(
      "Maya's manager, sam@company.com, has asked you to take Maya on. Accept or decline in Day0: https://day0.company.com/?transfer=t1. Nothing changes until you do.",
    );
  });

  it('leaves the link out when the deployment has no public address', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Maya',
        fromAddress: 'sam@company.com',
      }),
    ).toBe(
      "Maya's manager, sam@company.com, has asked you to take Maya on. Accept or decline in Day0. Nothing changes until you do.",
    );
  });

  it('escapes the three characters Slack reads as markup, so a name cannot become a link or a mention', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Ops <!channel> & co',
        fromAddress: 'sam@company.com',
      }),
    ).toBe(
      "Ops &lt;!channel&gt; &amp; co's manager, sam@company.com, has asked you to take Ops &lt;!channel&gt; &amp; co on. Accept or decline in Day0. Nothing changes until you do.",
    );
  });
});
