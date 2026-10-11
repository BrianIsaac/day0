/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  refusal: undefined as string | undefined,
  trustRefusal: undefined as string | undefined,
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
      if (backend.trustRefusal !== undefined) throw new Error(backend.trustRefusal);
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
  backend.trustRefusal = undefined;
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
      // The words follow the selection: trust is a weight on the ranking, not a rule (minor 3).
      // Re-pinned for W15-R45: "Within a source, a page’s own status decides" was wrong of a
      // page that is not current, which is read from no source.
      'Official is weighed above team, and team above personal, when pages answer alike. A page that is not current is read from no source; recency only breaks ties.',
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

  it('says a source was linked when only its trust could not be set, and clears the form so it is not linked twice', async (): Promise<void> => {
    // The second pass's minor 12: the link landed and the trust call failed, and the form said
    // "The location was not linked" with every field kept, so a retry linked it a second time.
    const view = mount(<LinkSourceForm />);
    typeInto(field(view.container, 'source-label'), 'Official runbooks');
    choose(view.container, 'source-trust', 'official');
    backend.trustRefusal = 'the backend is restarting';
    await press(view.container, 'Link location');
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual([
      'docSources:link',
      'docStatus:setSourceAuthority',
    ]);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'The location was linked, as a team source: its trust could not be set to official. Set it in the Trust column of the table.',
    );
    expect(field<HTMLInputElement>(view.container, 'source-label').value).toBe('');
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

  /** Choose a value in one of the form's selects. */
  function choose(scope: ParentNode, id: string, value: string): void {
    const select = field<HTMLSelectElement>(scope, id);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    act((): void => {
      setter?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it.each([
    {
      kind: 'confluence-v2',
      typed: 'https://acme.atlassian.net/wiki/spaces/OPS/overview',
      fields: {
        'reader-cloud-id': '1A11D016-8984-4C3E-B9AB-142DD06ACB1B',
        'reader-token': 'fixture-confluence-token',
      },
      locator:
        'https://api.atlassian.com/ex/confluence/1a11d016-8984-4c3e-b9ab-142dd06acb1b/wiki/spaces/OPS',
      credential: 'fixture-confluence-token',
    },
    {
      kind: 'confluence-dc',
      typed: 'https://wiki.acme.corp/confluence/spaces/OPS/overview',
      fields: { 'reader-token': 'fixture-confluence-pat' },
      locator: 'https://wiki.acme.corp/confluence/display/OPS',
      credential: 'fixture-confluence-pat',
    },
    {
      kind: 'sharepoint',
      typed: 'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents/Forms/AllItems.aspx',
      fields: {
        'reader-tenant-id': ' tenant-id ',
        'reader-client-id': 'client-id',
        'reader-client-secret': 'fixture-client-secret',
      },
      locator: 'https://acme.sharepoint.com/sites/Runbooks',
      credential: 'tenant-id:client-id:fixture-client-secret',
    },
    {
      kind: 'yuque',
      typed: 'https://acme.yuque.com/revops/runbooks/close-the-quarter',
      fields: { 'reader-token': 'fixture-yuque-token' },
      locator: 'https://acme.yuque.com/revops/runbooks',
      credential: 'fixture-yuque-token',
    },
    {
      kind: 'drive',
      typed:
        'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345?usp=sharing',
      fields: {
        'reader-key': '{ "client_email": "day0-reader@acme-docs.iam.gserviceaccount.com" }',
      },
      locator: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      credential: '{"client_email":"day0-reader@acme-docs.iam.gserviceaccount.com"}',
    },
  ])(
    'links a $kind source from the address the browser shows and its own secret fields, and clears them (15-X)',
    async ({ kind, typed, fields, locator, credential }): Promise<void> => {
      const view = mount(<LinkSourceForm />);
      choose(view.container, 'source-kind', kind);
      typeInto(field(view.container, 'source-label'), 'Runbooks');
      typeInto(field(view.container, 'source-locator'), typed);
      for (const [id, value] of Object.entries(fields)) {
        field<HTMLInputElement>(view.container, id).value = value;
      }

      await press(view.container, 'Link location');
      await settle();

      expect(backend.calls).toEqual([
        {
          name: 'docSources:link',
          args: { label: 'Runbooks', kind, locator, serverKind: undefined, credential },
        },
      ]);
      for (const id of Object.keys(fields)) {
        expect(field<HTMLInputElement>(view.container, id).value).toBe('');
      }
      view.unmount();
    },
  );

  it('never carries a secret typed for one kind into another kind’s field (second pass)', (): void => {
    const view = mount(<LinkSourceForm />);
    choose(view.container, 'source-kind', 'confluence-dc');
    field<HTMLInputElement>(view.container, 'reader-token').value = 'fixture-confluence-pat';
    choose(view.container, 'source-kind', 'yuque');
    expect(field<HTMLInputElement>(view.container, 'reader-token').value).toBe('');
    view.unmount();
  });

  it('keeps what was typed, the region and the secret with it, when the link is refused, so it can be corrected (W14-R38)', async (): Promise<void> => {
    backend.refusal = 'Uncaught Error: Feishu refused the app ID and secret this source uses.';
    const view = mount(<LinkSourceForm />);
    choose(view.container, 'source-kind', 'feishu');
    choose(view.container, 'feishu-region', 'lark');
    typeInto(field(view.container, 'source-label'), 'RevOps wiki');
    typeInto(field(view.container, 'source-locator'), '7300000000000000001');
    field<HTMLInputElement>(view.container, 'feishu-app-id').value = 'cli_fixture_app';
    field<HTMLInputElement>(view.container, 'feishu-app-secret').value = 'fixture-app-secret';

    await press(view.container, 'Link location');
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Feishu refused the app ID and secret this source uses.',
    );
    expect(field<HTMLSelectElement>(view.container, 'feishu-region').value).toBe('lark');
    expect(field<HTMLInputElement>(view.container, 'feishu-app-id').value).toBe('cli_fixture_app');
    expect(field<HTMLInputElement>(view.container, 'feishu-app-secret').value).toBe(
      'fixture-app-secret',
    );
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
