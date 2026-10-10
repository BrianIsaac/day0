/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  refusal: undefined as string | undefined,
}));

vi.mock('convex/react', () => ({
  useAction:
    (reference: unknown) =>
    async (args: unknown): Promise<string> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      if (backend.refusal !== undefined) throw new Error(backend.refusal);
      return 'source-1';
    },
  // The form sets a new source's trust once it is linked (15-A).
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<null> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      return null;
    },
}));

import { LinkSourceForm } from '../../../app/documentation/LinkSourceForm';
import { mount, press, settle, typeInto } from '../../fixtures/dom/press';

/** The field a label names. */
function field<Element extends HTMLElement>(scope: ParentNode, id: string): Element {
  const found = scope.querySelector<Element>(`#${id}`);
  if (!found) throw new Error(`no field #${id}`);
  return found;
}

afterEach((): void => {
  backend.calls = [];
  backend.refusal = undefined;
});

describe('LinkSourceForm and the trust of a new source (15-A; A19)', (): void => {
  /** Choose an option of one of the form's selects. */
  function choose(scope: ParentNode, id: string, value: string): void {
    const select = field<HTMLSelectElement>(scope, id);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act((): void => {
      setter?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('offers Official, Team and Personal, with Team chosen and what the three mean under it', (): void => {
    const view = mount(<LinkSourceForm />);
    const trust = field<HTMLSelectElement>(view.container, 'source-trust');
    expect([...trust.options].map((option) => [option.value, option.textContent])).toEqual([
      ['official', 'Official'],
      ['team', 'Team'],
      ['personal', 'Personal'],
    ]);
    expect(trust.value).toBe('team');
    expect(view.container.textContent).toContain(
      'Official beats team beats personal. Within a source, a page’s own status decides; recency only breaks ties.',
    );
    view.unmount();
  });

  it('links a team source with no second call, and sets another trust on the source once it is linked', async (): Promise<void> => {
    const view = mount(<LinkSourceForm />);
    await press(view.container, 'Link location');
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual(['docSources:link']);
    backend.calls = [];
    choose(view.container, 'source-trust', 'official');
    await press(view.container, 'Link location');
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual([
      'docSources:link',
      'docStatus:setSourceAuthority',
    ]);
    expect(backend.calls[1].args).toEqual({ sourceId: 'source-1', authority: 'official' });
    // The next source starts as a team source again.
    expect(field<HTMLSelectElement>(view.container, 'source-trust').value).toBe('team');
    view.unmount();
  });
});

describe('LinkSourceForm', (): void => {
  it('links a git repository with its reader secret, clears the secret at once and empties the fields', async (): Promise<void> => {
    const view = mount(<LinkSourceForm />);
    const kind = field<HTMLSelectElement>(view.container, 'source-kind');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act((): void => {
      setter?.call(kind, 'git');
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    typeInto(field(view.container, 'source-label'), 'Runbooks');
    typeInto(field(view.container, 'source-locator'), 'https://git.example/runbooks#main');
    field<HTMLInputElement>(view.container, 'reader-secret').value = 'value';

    await press(view.container, 'Link location');
    await settle();

    expect(backend.calls).toEqual([
      {
        name: 'docSources:link',
        args: {
          label: 'Runbooks',
          kind: 'git',
          locator: 'https://git.example/runbooks#main',
          serverKind: undefined,
          credential: 'value',
        },
      },
    ]);
    expect(field<HTMLInputElement>(view.container, 'reader-secret').value).toBe('');
    expect(field<HTMLInputElement>(view.container, 'source-label').value).toBe('');
    view.unmount();
  });

  it('links a Feishu wiki space with its region and app, joining the ID and secret and clearing both (14-F)', async (): Promise<void> => {
    const view = mount(<LinkSourceForm />);
    const choose = (id: string, value: string): void => {
      const select = field<HTMLSelectElement>(view.container, id);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      act((): void => {
        setter?.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    choose('source-kind', 'feishu');
    choose('feishu-region', 'lark');
    typeInto(field(view.container, 'source-label'), 'RevOps wiki');
    typeInto(field(view.container, 'source-locator'), '7300000000000000001');
    field<HTMLInputElement>(view.container, 'feishu-app-id').value = 'cli_fixture_app';
    field<HTMLInputElement>(view.container, 'feishu-app-secret').value = 'fixture-app-secret';

    await press(view.container, 'Link location');
    await settle();

    expect(backend.calls).toEqual([
      {
        name: 'docSources:link',
        args: {
          label: 'RevOps wiki',
          kind: 'feishu',
          locator: 'https://open.larksuite.com/wiki/spaces/7300000000000000001',
          serverKind: undefined,
          credential: 'cli_fixture_app:fixture-app-secret',
        },
      },
    ]);
    expect(field<HTMLInputElement>(view.container, 'feishu-app-secret').value).toBe('');
    expect(field<HTMLInputElement>(view.container, 'feishu-app-id').value).toBe('');
    view.unmount();
  });

  it('clears the folder default label when another kind is chosen, and keeps a typed one (14-F)', (): void => {
    const view = mount(<LinkSourceForm />);
    const kind = field<HTMLSelectElement>(view.container, 'source-kind');
    const choose = (value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      act((): void => {
        setter?.call(kind, value);
        kind.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    expect(field<HTMLInputElement>(view.container, 'source-label').value).toBe('Team folder');
    choose('feishu');
    expect(field<HTMLInputElement>(view.container, 'source-label').value).toBe('');
    typeInto(field(view.container, 'source-label'), 'RevOps wiki');
    choose('git');
    expect(field<HTMLInputElement>(view.container, 'source-label').value).toBe('RevOps wiki');
    view.unmount();
  });

  it('says a refusal under the form without the transport envelope', async (): Promise<void> => {
    backend.refusal =
      '[CONVEX A(docSources:link)] [Request ID: 1] Server Error\nUncaught Error: Documentation linking is a real-mode feature.\n    at handler (../convex/docSources.ts:1:1)';
    const view = mount(<LinkSourceForm />);

    await press(view.container, 'Link location');
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Documentation linking is a real-mode feature.',
    );
    view.unmount();
  });
});
