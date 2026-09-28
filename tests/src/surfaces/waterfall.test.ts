import { describe, expect, it } from 'vitest';
import {
  extractDocumentedSystemOrder,
  orderSurfaceWaterfall,
  waterfallEntry,
} from '../../../src/surfaces/waterfall';

describe('surface intake waterfall', (): void => {
  it('extracts the systems table without reading later tables or duplicates', (): void => {
    const onboarding = [
      '# Revenue operations onboarding',
      '',
      '## Systems and access owners',
      '',
      '| System | Use | Owner |',
      '|---|---|---|',
      '| Linear | Work queue | IT |',
      '| Slack | Requests | Messaging |',
      '| Northstar CRM | Records | Business systems |',
      '| Team documentation | Runbooks | Manager |',
      '',
      '## Another section',
      '',
      '| System | Not part of the waterfall |',
      '|---|---|',
      '| Twitter | Ignore |',
    ].join('\n');
    expect(
      extractDocumentedSystemOrder([
        { title: 'Revenue operations onboarding', content: onboarding },
        {
          title: 'Unrelated system page',
          content:
            '## Systems and access owners\n\n| System | Owner |\n|---|---|\n| Ignore me | IT |',
        },
      ]),
    ).toEqual(['Linear', 'Slack', 'Northstar CRM', 'Team documentation']);
  });

  it('keeps of a page only what the order reads, so a paged walk holds no body without a systems table', (): void => {
    const table = '## Systems and access owners\n\n| System |\n|---|\n| Linear |';
    expect(waterfallEntry({ title: 'Onboarding', content: '# Welcome\n\nRead on.' })).toEqual({
      title: 'Onboarding',
      content: '',
    });
    expect(waterfallEntry({ title: 'Systems', content: table })).toEqual({
      title: 'Systems',
      content: table,
    });
    const pages = [
      { title: 'Onboarding', content: '# Welcome\n\nRead on.' },
      { title: 'Systems', content: table },
    ];
    // An onboarding page with no table still makes the other pages non-authoritative.
    expect(extractDocumentedSystemOrder(pages.map(waterfallEntry))).toEqual(
      extractDocumentedSystemOrder(pages),
    );
  });

  it('puts documented systems first and class fallbacks after them', (): void => {
    const surfaces = [
      { slug: 'mastodon', displayName: 'Mastodon', class: 'social' },
      { slug: 'chatwork', displayName: 'Chatwork', class: 'chat' },
      { slug: 'linear', displayName: 'Linear', class: 'kanban' },
      { slug: 'sheets', displayName: 'Google Sheets', class: 'spreadsheet' },
      { slug: 'slack', displayName: 'Slack', class: 'chat' },
      { slug: 'other', displayName: 'Other system', class: 'other' },
    ];
    expect(
      orderSurfaceWaterfall(surfaces, ['Slack', 'Linear']).map((row): string => row.slug),
    ).toEqual(['slack', 'linear', 'chatwork', 'sheets', 'mastodon', 'other']);
    expect(surfaces.map((row): string => row.slug)).toEqual([
      'mastodon',
      'chatwork',
      'linear',
      'sheets',
      'slack',
      'other',
    ]);
  });

  it('keeps stable input order inside an unranked class', (): void => {
    const surfaces = [
      { slug: 'second', displayName: 'Second chat', class: 'chat' },
      { slug: 'first', displayName: 'First chat', class: 'chat' },
    ];
    expect(orderSurfaceWaterfall(surfaces, []).map((row): string => row.slug)).toEqual([
      'second',
      'first',
    ]);
  });
});
