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
