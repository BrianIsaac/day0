import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Link from 'next/link';
import { Button, ButtonLink } from '../../app/components/Button';
import { Card } from '../../app/components/Card';
import { FirstWeekCard } from '../../app/components/FirstWeekCard';
import type { RailStep } from '../../app/components/FirstWeekRail';
import { Tabs, type TabItem } from '../../app/components/Tabs';

/**
 * Print the employee page's controls and a sentence with a link in it, each under a
 * `data-probe` naming it, for the browser job to mount under the build's stylesheet and read the
 * focus ring and the link underline off (C1, C3). It runs under `tsx` in its own process, as
 * `tab-strip-markup.ts` does, because a spec cannot render the product's components itself.
 */

/** Three of the employee page's tabs, the first selected. */
const TABS: readonly TabItem[] = [
  { key: 'needs-you', label: 'Needs you', href: '/a/needs-you', count: 1, hot: true },
  { key: 'work', label: 'Work', href: '/a/work' },
  { key: 'charter', label: 'Charter', href: '/a/charter' },
];

/** The rail's week as an employee at Working has it; the card is its one control. */
const WEEK: readonly RailStep[] = [
  { title: 'Deployed', detail: '30 Sep 2026, 04:30', status: 'done' },
  { title: 'Day-1 one-to-one', detail: '30 Sep 2026, 04:52', status: 'done' },
  { title: 'Charter approved', detail: 'version 0.1', status: 'done' },
  { title: 'First supervised write', detail: 'landed', status: 'done' },
  { title: 'Working', detail: 'since 30 Sep 2026, 14:22', status: 'now' },
];

/**
 * One probe: a named wrapper around what it holds.
 *
 * @param name - What the spec finds it by.
 * @param child - The rendered control.
 */
function probe(name: string, child: ReturnType<typeof h>): ReturnType<typeof h> {
  return h('div', { 'data-probe': name, style: { marginBottom: '12px' } }, child);
}

process.stdout.write(
  renderToStaticMarkup(
    h(
      'div',
      null,
      probe(
        'prose',
        h(Card, {
          title: 'No reorientation card is open',
          children: h(
            'p',
            { className: 'text-sm text-[var(--color-fg-2)]' },
            'When you want it to work differently, amend the charter on the ',
            h(Link, { href: '/a/charter' }, 'Charter tab'),
            '.',
          ),
        }),
      ),
      probe('button', h(Button, { variant: 'primary' }, 'Approve')),
      probe('button-link', h(ButtonLink, { href: '/a/work' }, 'Open the item')),
      probe('text-link', h(ButtonLink, { href: '/a/work', variant: 'text' }, 'Show the rest')),
      probe(
        'tabs',
        h(Tabs, { label: 'Employee page', items: TABS, selected: 'needs-you', panelId: 'panel' }),
      ),
      probe('card', h(FirstWeekCard, { steps: WEEK })),
    ),
  ),
);
