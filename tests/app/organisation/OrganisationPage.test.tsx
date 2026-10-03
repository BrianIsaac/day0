/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The organisation page against its backend by function name (B8): what it asks, what it calls
 * and what it says, for an administrator and for a manager, with axe and the 44 px floor.
 */
const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  asked: [] as Array<{ name: string; args: unknown }>,
  calls: [] as Array<{ name: string; args: unknown }>,
  refusals: {} as Record<string, string>,
  results: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name] ?? null;
    };
  return {
    useQuery: (reference: unknown, args: unknown): unknown => {
      const name = getFunctionName(reference as never);
      backend.asked.push({ name, args });
      return args === 'skip' ? undefined : backend.queries[name];
    },
    useMutation: call,
    useAction: call,
  };
});

import { OrganisationPage } from '../../../app/organisation/OrganisationPage';
import { axeViolations } from '../../fixtures/dom/axe';
import {
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
  unmountAll,
} from '../../fixtures/dom/press';
import { underTarget } from '../../fixtures/dom/targets';

const AT = Date.UTC(2026, 9, 1, 9, 30);

const SLACK = {
  _id: 'connection-slack',
  system: 'slack',
  displayName: 'Slack',
  kind: 'slack-configuration',
  mode: 'per-employee',
  scopes: ['chat:write', 'channels:join'],
  registeredBy: { via: 'organisation-page', address: 'ines@acme.test', at: AT },
  status: 'active',
  createdAt: AT,
  hasSecret: true,
  secretExpiresAt: AT + 12 * 3_600_000,
};

const LINEAR = {
  _id: 'connection-linear',
  system: 'linear',
  displayName: 'Linear',
  kind: 'oauth-app',
  mode: 'per-employee',
  scopes: ['read', 'write'],
  registeredBy: { via: 'setup-cli', at: AT },
  status: 'needs-attention',
  statusReason: 'Linear refused the client secret.',
  createdAt: AT,
  hasSecret: false,
};

const DOCS = {
  _id: 'connection-docs',
  system: 'mcp:docs.acme.test',
  displayName: 'Acme docs',
  kind: 'mcp-client',
  clientRegistration: 'pre-registered',
  mode: 'per-employee',
  scopes: ['docs.read'],
  registeredBy: { via: 'setup-cli', at: AT - 86_400_000 },
  status: 'revoked',
  statusReason: 'The server moved.',
  revokedAt: AT,
  createdAt: AT - 86_400_000,
  hasSecret: false,
};

const LEDGER = [
  {
    _id: 'line-2',
    organisationConnectionId: 'connection-docs',
    type: 'organisation.connection-revoked',
    payload: {
      organisationConnectionId: 'connection-docs',
      system: 'mcp:docs.acme.test',
      displayName: 'Acme docs',
      via: 'organisation-page',
      reason: 'The server moved.',
    },
    actorAddress: 'ines@acme.test',
    createdAt: AT,
  },
  {
    _id: 'line-1',
    organisationConnectionId: 'connection-slack',
    type: 'organisation.connection-landed',
    payload: {
      organisationConnectionId: 'connection-slack',
      system: 'slack',
      displayName: 'Slack',
      via: 'setup-cli',
      kind: 'slack-configuration',
      mode: 'per-employee',
      scopes: ['chat:write'],
    },
    createdAt: AT - 60_000,
  },
];

/** The backend as an administrator sees it. */
function asAdministrator(connections: unknown[] = [SLACK, LINEAR, DOCS]): void {
  backend.queries = {
    'organisationConnections:summaryForManager': { callerIsAdministrator: true, systems: [] },
    'organisationConnections:listForAdministrator': connections,
    'connectionEvents:forAdministrator': LEDGER,
  };
}

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
  backend.queries = {};
  backend.asked = [];
  backend.calls = [];
  backend.refusals = {};
  backend.results = {};
});

/** The page's text, with what a screen reader is not told left out. */
function text(root: ParentNode): string {
  return (root as Element).textContent ?? '';
}

describe('the organisation page for a manager who is not an administrator (B8)', (): void => {
  it('refuses in words, asks no administrator read, and passes axe', async (): Promise<void> => {
    backend.queries = {
      'organisationConnections:summaryForManager': { callerIsAdministrator: false, systems: [] },
    };
    const view = mount(<OrganisationPage />);
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe(
      "This page is for your organisation's administrators",
    );
    expect(text(view.container)).toContain("Each employee's access is still yours to approve");
    expect(view.container.querySelector('a[href="/"]')?.textContent).toBe('Back to your employees');
    expect(
      backend.asked
        .filter((ask) => ask.name !== 'organisationConnections:summaryForManager')
        .every((ask) => ask.args === 'skip'),
    ).toBe(true);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });

  it('says it is loading while the caller is read', (): void => {
    const view = mount(<OrganisationPage />);
    expect(text(view.container)).toContain("Loading the organisation's connections");
  });
});

describe('the organisation page for an administrator', (): void => {
  it('lists each connection with its mode, what IT registered, its status, who registered it and its secret', async (): Promise<void> => {
    asAdministrator();
    const view = mount(<OrganisationPage zone="UTC" />);
    await settle();
    const cards = [...view.container.querySelectorAll('section[data-connection]')];
    expect(cards.map((card) => card.getAttribute('data-connection'))).toEqual([
      'connection-slack',
      'connection-linear',
      'connection-docs',
    ]);
    const slack = text(cards[0]);
    expect(slack).toContain('Active');
    expect(slack).toContain('Each employee gets its own identity');
    expect(slack).toContain("Slack configuration token, which creates each employee's app");
    expect(slack).toContain('ines@acme.test, on this page, 1 Oct 2026, 09:30');
    expect(slack).toContain('Held encrypted; it expires 1 Oct 2026, 21:30');
    expect(slack).toContain('chat:write, channels:join');
    const linear = text(cards[1]);
    expect(linear).toContain('Needs IT');
    expect(linear).toContain('Linear refused the client secret.');
    expect(linear).toContain('The setup command, 1 Oct 2026, 09:30');
    const docs = text(cards[2]);
    expect(docs).toContain('Revoked');
    expect(docs).toContain('The server moved.');
    // Rotate where a secret is held; revoke on any connection not yet revoked.
    const buttons = (card: Element): string[] =>
      [...card.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(buttons(cards[0])).toEqual(['Give it a new secret', 'Revoke']);
    expect(buttons(cards[1])).toEqual(['Revoke']);
    expect(buttons(cards[2])).toEqual([]);
  });

  it('shows the ledger newest first in the record’s words, with who made each change', async (): Promise<void> => {
    asAdministrator();
    const view = mount(<OrganisationPage zone="UTC" />);
    await settle();
    const lines = [...view.container.querySelectorAll('[data-ledger] li')].map((line) =>
      text(line),
    );
    expect(lines[0]).toContain(
      "The organisation's Acme docs connection was revoked by an administrator: The server moved. By ines@acme.test.",
    );
    expect(lines[1]).toContain('Slack was connected for the organisation by the setup command.');
  });

  it('says no system is connected yet, and how IT connects one', async (): Promise<void> => {
    asAdministrator([]);
    backend.queries['connectionEvents:forAdministrator'] = [];
    const view = mount(<OrganisationPage zone="UTC" />);
    await settle();
    expect(text(view.container)).toContain('No system is connected for the organisation yet.');
    expect(text(view.container)).toContain('No change to a connection yet.');
  });

  it('passes axe with every state drawn, and keeps every control at 44 px', async (): Promise<void> => {
    asAdministrator();
    const view = mount(
      <main>
        <OrganisationPage zone="UTC" />
      </main>,
    );
    await settle();
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });
});

describe('revoking and rotating a connection, confirmed first', (): void => {
  /** The open dialog. */
  function dialog(): HTMLElement {
    const found = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
    if (!found) throw new Error('no dialog open');
    return found;
  }

  /** The Slack card's control by its text. */
  async function open(control: string): Promise<void> {
    const card = document.querySelector('section[data-connection="connection-slack"]');
    if (!card) throw new Error('no Slack card');
    await press(card, control);
  }

  it('names what a revoke ends, asks for the reason, holds Revoke until one is given, and revokes with it', async (): Promise<void> => {
    asAdministrator();
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Revoke');
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(focusedName()).toBe('Keep it');
    expect(text(dialog())).toContain(
      "Every employee's Slack card connected through it ends now, each with your reason, and what Day0 obtained through it is revoked at Slack.",
    );
    const revoke = [...dialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Revoke Slack',
    );
    expect(revoke?.disabled).toBe(true);
    const reason = dialog().querySelector<HTMLInputElement>('input');
    if (!reason) throw new Error('no reason field');
    typeInto(reason, 'Moving to a new workspace');
    await press(dialog(), 'Revoke Slack');
    expect(backend.calls).toEqual([
      {
        name: 'organisationConnections:revoke',
        args: { organisationConnectionId: 'connection-slack', reason: 'Moving to a new workspace' },
      },
    ]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // Its Revoke goes with the revoke: the connection's card takes focus, never the page (bed).
    expect(document.activeElement).toBe(
      document.querySelector('section[data-connection="connection-slack"]'),
    );
  });

  it("asks how many cards a revoke ends, and says the number (11-AC's item 3)", async (): Promise<void> => {
    asAdministrator();
    backend.queries['organisationConnections:cardsOn'] = { cards: 3, atLeast: false };
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Revoke');
    expect(text(dialog())).toContain(
      '3 employee cards connected through it end now, each with your reason, and what Day0 obtained through it is revoked at Slack.',
    );
    expect(backend.asked).toContainEqual({
      name: 'organisationConnections:cardsOn',
      args: { organisationConnectionId: 'connection-slack' },
    });
  });

  it("names the reason the record's alone where the revoke ends no card (the second pass's design reader)", async (): Promise<void> => {
    asAdministrator();
    backend.queries['organisationConnections:cardsOn'] = { cards: 0, atLeast: false };
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Revoke');
    expect(text(dialog())).toContain('The reason for the record');
    expect(text(dialog())).toContain('No card shows it.');
    expect(text(dialog())).not.toContain('The reason each card will show');
  });

  it('holds Revoke where more cards use the connection than one revoke ends, which the backend refuses', async (): Promise<void> => {
    asAdministrator();
    backend.queries['organisationConnections:cardsOn'] = { cards: 1000, atLeast: true };
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Revoke');
    const reason = dialog().querySelector<HTMLInputElement>('input');
    if (!reason) throw new Error('no reason field');
    typeInto(reason, 'Moving to a new workspace');
    const revoke = [...dialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Revoke Slack',
    );
    expect(revoke?.disabled).toBe(true);
  });

  it('says a refused revoke inside the dialog and keeps it open', async (): Promise<void> => {
    asAdministrator();
    backend.refusals['organisationConnections:revoke'] = 'The connection is already revoked.';
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Revoke');
    const reason = dialog().querySelector<HTMLInputElement>('input');
    if (!reason) throw new Error('no reason field');
    typeInto(reason, 'Moving');
    await press(dialog(), 'Revoke Slack');
    expect(said(dialog())).toContain('The connection is already revoked.');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(await axeViolations(document.body, ['region'])).toEqual([]);
    expect(underTarget(dialog())).toEqual([]);
  });

  it('rotates with the new secret and refresh token from a form that keeps neither, and says no card ends', async (): Promise<void> => {
    asAdministrator();
    mount(<OrganisationPage zone="UTC" />);
    await settle();
    await open('Give it a new secret');
    expect(text(dialog())).toContain('No card is affected');
    // Slack's auth.revoke ends the old token alone (the round review's m17).
    expect(text(dialog())).toContain("Nothing ends that token's refresh token");
    const [secret, refresh] = [...dialog().querySelectorAll<HTMLInputElement>('input')];
    expect(secret?.type).toBe('password');
    expect(refresh?.type).toBe('password');
    if (!secret || !refresh) throw new Error('no secret fields');
    typeInto(secret, 'xoxe-1234567890-abcdefghij');
    typeInto(refresh, 'xoxe-1-abcdefghij');
    const form = dialog().querySelector('form');
    act((): void => {
      form?.requestSubmit();
    });
    await settle();
    expect(backend.calls).toEqual([
      {
        name: 'organisationConnections:rotate',
        args: {
          organisationConnectionId: 'connection-slack',
          secret: 'xoxe-1234567890-abcdefghij',
          refreshToken: 'xoxe-1-abcdefghij',
        },
      },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("recording an employee's own Linear app from its access request's link (AL9)", (): void => {
  it('records the app for the card the link names, then opens Linear to install it', async (): Promise<void> => {
    asAdministrator([{ ...LINEAR, status: 'active', statusReason: undefined }]);
    backend.results['linearIdentityActions:registerEmployeeApp'] = {
      ok: true,
      authoriseUrl: 'https://linear.app/oauth/authorize?client_id=c1',
    };
    const navigate = vi.fn();
    const view = mount(
      <OrganisationPage zone="UTC" cardId="surface-leo-linear" navigate={navigate} />,
    );
    await settle();
    const form = view.container.querySelector<HTMLFormElement>('form[data-employee-app]');
    if (!form) throw new Error('no employee app form');
    const [clientId, secret] = [...form.querySelectorAll<HTMLInputElement>('input')];
    if (!clientId || !secret) throw new Error('no fields');
    expect(secret.type).toBe('password');
    typeInto(clientId, 'c1');
    typeInto(secret, 'linear-secret-abcdefghij');
    act((): void => {
      form.requestSubmit();
    });
    await settle();
    expect(backend.calls).toEqual([
      {
        name: 'linearIdentityActions:registerEmployeeApp',
        args: {
          surfaceId: 'surface-leo-linear',
          clientId: 'c1',
          clientSecret: 'linear-secret-abcdefghij',
        },
      },
    ]);
    expect(navigate).toHaveBeenCalledWith('https://linear.app/oauth/authorize?client_id=c1');
  });

  it('offers no form without a link naming the card, and says where the link comes from', async (): Promise<void> => {
    asAdministrator([{ ...LINEAR, status: 'active', statusReason: undefined }]);
    const view = mount(<OrganisationPage zone="UTC" />);
    await settle();
    expect(view.container.querySelector('form[data-employee-app]')).toBeNull();
    expect(text(view.container)).toContain(
      "An employee's own Linear app is recorded from the link in its access request.",
    );
  });
});
