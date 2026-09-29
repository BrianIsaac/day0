import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, type TabItem } from '../../app/components/Tabs';

/**
 * Print the employee page's tab strip as markup, for the browser job to mount under the build's
 * stylesheet. It runs under `tsx` in its own process: Playwright compiles a spec's JSX for its
 * component runner, so a spec cannot render the product's components itself.
 */

/** The employee page's nine tabs, with the counts the bed showed; the first is selected. */
const ITEMS: readonly TabItem[] = [
  { key: 'needs-you', label: 'Needs you', href: '/a/needs-you', count: 1, hot: true },
  { key: 'work', label: 'Work', href: '/a/work', count: 2 },
  { key: 'charter', label: 'Charter', href: '/a/charter' },
  { key: 'people', label: 'People', href: '/a/people' },
  { key: 'documentation', label: 'Documentation', href: '/a/documentation' },
  { key: 'skills', label: 'Skills', href: '/a/skills', count: 1 },
  { key: 'surfaces', label: 'Surfaces', href: '/a/surfaces' },
  { key: 'record', label: 'Record', href: '/a/record' },
  { key: 'manage', label: 'Manage', href: '/a/manage' },
];

process.stdout.write(
  renderToStaticMarkup(
    createElement(Tabs, {
      label: 'Employee page',
      items: ITEMS,
      selected: 'needs-you',
      panelId: 'panel',
    }),
  ),
);
