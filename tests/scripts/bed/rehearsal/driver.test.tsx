/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import type { UIMessage } from 'ai';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
  /** The 1:1's history, one array for every render, as `useChat` keeps it. */
  messages: [] as unknown[],
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (): Promise<unknown> =>
      backend.results[getFunctionName(reference as never)];
  return {
    useQuery: (reference: unknown, args?: unknown): unknown =>
      args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

vi.mock('@ai-sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/react')>()),
  useChat: () => ({
    messages: backend.messages,
    sendMessage: (): void => undefined,
    regenerate: (): void => undefined,
    setMessages: (): void => undefined,
    status: 'ready',
  }),
}));

import {
  agentIdFromUrl,
  APPROVE_ALL,
  APPROVE_CARD,
  APPROVE_CHARTER,
  APPROVE_PLAN,
  APPROVE_SKILL,
  ASK_AGAIN,
  CANCEL_ITEM,
  CANCEL_WITHOUT_REASON,
  COMPLETE_LINE,
  CREDENTIAL_INPUT,
  EMPLOYEE_TAB_SEGMENTS,
  lastEmployeeTurn,
  nextTurnStep,
  REPLY_PLACEHOLDER,
  surfaceCard,
  TAKE_IT_ANYWAY,
  tabPath,
} from '../../../../scripts/bed/rehearsal/driver';
import { ChatRoom } from '../../../../app/agent/[agentId]/ChatRoom';
import { CharterCard } from '../../../../app/agent/[agentId]/charter/CharterCard';
import { EMPLOYEE_TABS, employeeTabHref } from '../../../../app/agent/[agentId]/employee-tabs';
import { ProposedSkillsPanel } from '../../../../app/agent/[agentId]/skills/ProposedSkillsPanel';
import {
  SurfaceCard,
  type ListedSurface,
  type SurfaceCardActions,
  type SurfaceCardContext,
} from '../../../../app/agent/[agentId]/surfaces/SurfaceCard';
import { AgentZoneContext } from '../../../../app/components/time';
import { WorkItemCard } from '../../../../app/agent/[agentId]/work/WorkItemCard';
import { INIT_PROMPT } from '../../../../src/agent/day-one-turn';
import { DRAWN, EMPLOYEE, QUESTION, SURFACES, ZONE } from '../../../fixtures/work/drawn-states';
import { mount, press, settle, unmountAll } from '../../../fixtures/dom/press';

/*
 * The driver finds each control by its role and accessible name, as Playwright's `getByRole`
 * does, so each pin renders the component the page draws and looks the control up the same way:
 * a renamed control or a moved card fails here, in the gate, rather than on the next bed run.
 */

/** Which elements hold each role the driver looks up. */
const ROLE_SELECTORS = {
  button: 'button, [role="button"]',
  article: 'article, [role="article"]',
  listitem: 'li, [role="listitem"]',
  log: '[role="log"]',
} as const;

/** An element's accessible name, as far as the driver's lookups read one. */
function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  return (element.getAttribute('aria-label') ?? element.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every element of a role whose accessible name is the one given (exactly, or by pattern). */
function byRole(
  scope: ParentNode,
  role: keyof typeof ROLE_SELECTORS,
  name: string | RegExp,
): Element[] {
  return [...scope.querySelectorAll(ROLE_SELECTORS[role])].filter((element) => {
    const found = accessibleName(element);
    return typeof name === 'string' ? found === name : name.test(found);
  });
}

/** The one element of a role with that name. */
function oneByRole(scope: ParentNode, role: keyof typeof ROLE_SELECTORS, name: string | RegExp) {
  const found = byRole(scope, role, name);
  expect(found, `${role} named ${String(name)}`).toHaveLength(1);
  return found[0] as HTMLElement;
}

beforeEach((): void => {
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
});

afterEach((): void => {
  unmountAll();
  backend.results = {};
  backend.queries = {};
  backend.messages = [];
  document.body.replaceChildren();
});

describe('the dashboard driver', (): void => {
  it('reads the agent id out of the agent page URL', (): void => {
    expect(agentIdFromUrl('http://localhost:45213/agent/j57bs4z36f3dp3qt4kne7sqwqh8dn9ns')).toBe(
      'j57bs4z36f3dp3qt4kne7sqwqh8dn9ns',
    );
    expect(agentIdFromUrl('http://localhost:45213/agent/abc#surfaces')).toBe('abc');
    expect(() => agentIdFromUrl('http://localhost:45213/')).toThrow('not an agent page');
  });

  it("opens each tab at the address the page's own tab strip links to", (): void => {
    expect(EMPLOYEE_TAB_SEGMENTS).toEqual(EMPLOYEE_TABS);
    for (const tab of EMPLOYEE_TABS) {
      expect(tabPath('a1', tab)).toBe(employeeTabHref('a1', tab));
    }
  });

  it('asks a failed turn again before it answers, and never answers a question nobody put', (): void => {
    // A failed turn opens the composer too, so waiting for the composer alone
    // would type the next scripted answer under an empty or half-said turn.
    expect(nextTurnStep({ complete: false, askAgain: true, composerOpen: true })).toBe('ask-again');
    expect(nextTurnStep({ complete: false, askAgain: false, composerOpen: true })).toBe('reply');
    expect(nextTurnStep({ complete: true, askAgain: true, composerOpen: true })).toBe('complete');
    expect(nextTurnStep({ complete: false, askAgain: false, composerOpen: false })).toBe('wait');
    // The room draws Ask again and the closing line under those words.
    const chat = readFileSync('app/agent/[agentId]/ChatRoom.tsx', 'utf8');
    expect(chat).toMatch(new RegExp(`>\\s*${ASK_AGAIN}\\s*</(button|Button)>`));
    expect(chat).toContain(COMPLETE_LINE);
  });

  it("reads the employee's last turn out of the 1:1's rendered log, not the manager's", async (): Promise<void> => {
    backend.results = { 'voice:start': { sessionId: 'session-1', turns: [], replyDraft: null } };
    backend.queries = { 'voice:latest': null };
    backend.messages = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: INIT_PROMPT }] },
      // Turns the session kept, as the room draws them (the composer opens on a kept question).
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Why this hire?' }],
        metadata: { kept: true },
      },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Close week is heavy.' }] },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'What does **day one** hold?' }],
        metadata: { kept: true },
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'The close tickets.' }] },
    ] satisfies UIMessage[];
    const view = mount(<ChatRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />);
    await settle();
    const log = oneByRole(document, 'log', 'The 1:1 so far');
    const turns = [...log.querySelectorAll(':scope > div')].map((turn) => turn.textContent ?? '');
    expect(lastEmployeeTurn(turns)).toBe('What does day one hold?');
    expect(lastEmployeeTurn([])).toBe('');
    expect(document.querySelector(`[placeholder="${REPLY_PLACEHOLDER}"]`)).not.toBeNull();
    view.unmount();
  });

  it('approves the drafted charter with the control the Charter tab draws', (): void => {
    const draft = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '0.1',
      approved: false,
      createdAt: 1,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction: 'Own routine revenue operations work from Linear tickets.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
        constraints: [
          {
            kind: 'candidate-property',
            quote: 'only the close tickets',
            wording: ['close tickets'],
            origin: 'manager-said',
          },
        ],
      },
    } as unknown as Doc<'charters'>;
    const view = mount(<CharterCard charter={draft} />);
    oneByRole(view.container, 'button', APPROVE_CHARTER);
    // With a rule struck the button says so, and the driver's name still finds it.
    expect(APPROVE_CHARTER.test('Approve charter, 1 rule struck')).toBe(true);
    view.unmount();
  });

  /** One work item's card as the Work tab draws it. */
  function workCard(item: Doc<'workItems'>, questions: unknown[] = []) {
    const noop = async (): Promise<void> => undefined;
    return mount(
      <AgentZoneContext value={ZONE}>
        <WorkItemCard
          item={item}
          surfaces={SURFACES}
          autonomousActions={false}
          employeeName={EMPLOYEE}
          questions={questions as never}
          onApprovePlan={noop}
          onCancelPlan={noop}
          onRetryFailed={noop}
          onReconcileFailed={noop}
          onApproveActions={noop}
          onRejectActions={noop}
          onResendDecision={noop}
          onDismiss={noop}
          servedByLoop
        />
      </AgentZoneContext>,
    );
  }

  it('finds a work item as the article its title names, and approves its plan, questions or not', (): void => {
    const item = DRAWN.planPending as Doc<'workItems'>;
    const view = workCard(item, [QUESTION]);
    const card = oneByRole(document, 'article', item.title);
    expect(oneByRole(card, 'button', APPROVE_PLAN).textContent).toBe('Approve plan with answers');
    expect(APPROVE_PLAN.test('Approve plan')).toBe(true);
    view.unmount();
  });

  it('cancels a plan with Cancel this item, then Cancel without a reason', async (): Promise<void> => {
    const item = DRAWN.planPending as Doc<'workItems'>;
    const view = workCard(item);
    const card = oneByRole(document, 'article', item.title);
    oneByRole(card, 'button', CANCEL_ITEM);
    await press(card, CANCEL_ITEM);
    oneByRole(card, 'button', CANCEL_WITHOUT_REASON);
    view.unmount();
  });

  it('approves every held action from the card that holds them', (): void => {
    const item = DRAWN.held as Doc<'workItems'>;
    const view = workCard(item);
    oneByRole(oneByRole(document, 'article', item.title), 'button', APPROVE_ALL);
    view.unmount();
  });

  it('hands a skipped ticket back with the control a skipped card renders', (): void => {
    const item = DRAWN.discovered as Doc<'workItems'>;
    const view = workCard(item);
    oneByRole(oneByRole(document, 'article', item.title), 'button', TAKE_IT_ANYWAY);
    view.unmount();
  });

  it('approves a proposed skill from the list item its name is in', (): void => {
    const skill = {
      _id: 'skill-1',
      _creationTime: 0,
      agentId: 'agent-1',
      name: 'refresh-the-tile',
      description: 'refresh the analytics tile',
      sourceType: 'agent-authored',
      createdAt: 0,
      state: 'proposed',
      requiredScopes: [],
    } as unknown as Doc<'skills'>;
    const view = mount(
      <ProposedSkillsPanel
        name="Mira"
        itemTitles={new Map()}
        skills={[skill]}
        surfaces={[]}
        onAuthoringAttempt={(): void => undefined}
      />,
    );
    // Playwright's filter: the list item holding an element whose text is the name, exactly.
    const items = byRole(document, 'listitem', /.*/).filter((item) =>
      [...item.querySelectorAll('*')].some((element) => element.textContent === skill.name),
    );
    expect(items).toHaveLength(1);
    oneByRole(items[0] as HTMLElement, 'button', APPROVE_SKILL);
    view.unmount();
  });

  describe('the surface cards', (): void => {
    const NOW = Date.UTC(2026, 8, 29, 12);
    const context: SurfaceCardContext = {
      now: NOW,
      sourceLabels: new Map(),
      credentials: new Map(),
      installRedirectConfigured: false,
      browserPresent: true,
    };
    const actions: SurfaceCardActions = {
      approve: (): void => undefined,
      reject: (): void => undefined,
      probe: (): void => undefined,
      land: (): void => undefined,
      provision: (): void => undefined,
      setDays: async () => ({ expiresAt: NOW }),
      approveTools: async () => undefined,
    };
    const looker = (fields: Partial<ListedSurface>): ListedSurface =>
      ({
        _id: 'surface-looker',
        _creationTime: 1,
        agentId: 'agent-1',
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'proposed',
        path: 'browser-driven',
        endpoint: 'http://looker-tile:8080/',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
        request: {
          credential: {
            found: 'location',
            label: 'looker pipeline tile dashboard login',
            location: 'Looker / Access',
          },
        },
        credentialLocation: 'Looker / Access',
        ...fields,
      }) as ListedSurface;
    const draw = (surface: ListedSurface) =>
      mount(
        <AgentZoneContext value="UTC">
          <SurfaceCard
            surface={surface}
            context={context}
            operation={undefined}
            actions={actions}
          />
        </AgentZoneContext>,
      );

    it('finds a proposed card by its slug, reads its verdict, and approves it', (): void => {
      const view = draw(looker({}));
      const card = document.querySelector<HTMLElement>(surfaceCard('looker-pipeline-tile'));
      expect(card?.dataset.verdict).toBe('proposed');
      const approve = oneByRole(card as HTMLElement, 'button', APPROVE_CARD) as HTMLButtonElement;
      expect(approve.disabled).toBe(false);
      // Before approval the card asks for nothing, so the driver approves first (D's M13).
      expect(card?.querySelector(CREDENTIAL_INPUT)).toBeNull();
      view.unmount();
    });

    it('reads why Approve is disabled from its description, as the driver does before a click', (): void => {
      const refusal =
        'A documented intake queue changed; reject this card and re-run orientation before approval.';
      const view = draw(looker({ approvalRefusal: refusal }));
      const card = document.querySelector<HTMLElement>(surfaceCard('looker-pipeline-tile'));
      const approve = oneByRole(card as HTMLElement, 'button', APPROVE_CARD) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      const reason = approve.getAttribute('aria-describedby') ?? '';
      expect(document.querySelector(`[id="${reason}"]`)?.textContent).toBe(refusal);
      view.unmount();
    });

    it('lands the credential in the field an approved card draws', (): void => {
      const view = draw(looker({ verdict: 'approved', managerApprovedAt: NOW - 60_000 }));
      const card = document.querySelector<HTMLElement>(surfaceCard('looker-pipeline-tile'));
      expect(card?.querySelector(CREDENTIAL_INPUT)).not.toBeNull();
      expect(byRole(card as HTMLElement, 'button', /Land/)).toHaveLength(1);
      view.unmount();
    });
  });
});
