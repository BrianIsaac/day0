import { describe, expect, it } from 'vitest';
import {
  appIdentityOf,
  recordFromText,
  samePerson,
  ticketAssignee,
  ticketHolder,
  ticketChange,
  ticketRecordRefusal,
  ticketRereadStopReason,
  ticketSnapshot,
  withheldBeforeFirstWrite,
  type PersonIdentity,
  type TicketSnapshot,
} from '../../../src/work/ticket-ownership';

const OWNER: PersonIdentity = { id: 'user-key', email: 'ops@kestrel.test' };
const todo: TicketSnapshot = {
  assigned: false,
  state: 'Todo',
  stateType: 'unstarted',
  doNotAutomate: false,
};

/** The key's owner, counting how often it was asked for. */
function ownerRead(owner: PersonIdentity | 'unread' = OWNER): {
  read: () => Promise<PersonIdentity | undefined>;
  calls: () => number;
} {
  let calls = 0;
  return {
    read: async (): Promise<PersonIdentity | undefined> => {
      calls += 1;
      return owner === 'unread' ? undefined : owner;
    },
    calls: (): number => calls,
  };
}

describe('ticket ownership', () => {
  it('identifies a person by id, then by email, and never by a bare name', () => {
    expect(ticketAssignee({ assignee: 'Kestrel Ops', assigneeId: 'USER-ANA' })).toEqual({
      id: 'user-ana',
      email: undefined,
    });
    expect(ticketAssignee({ assignee: 'Kestrel Ops' })).toEqual({
      id: undefined,
      email: undefined,
    });
    expect(ticketAssignee({ assignee: { name: 'ops', email: 'OPS@kestrel.test' } })).toEqual({
      id: undefined,
      email: 'ops@kestrel.test',
    });
    expect(ticketAssignee({ title: 'Nobody on it' })).toBeUndefined();
    expect(samePerson({ id: 'user-ana', email: 'ops@kestrel.test' }, OWNER)).toBe(false);
    expect(samePerson({ email: 'ops@kestrel.test' }, OWNER)).toBe(true);
    expect(samePerson({}, OWNER)).toBeUndefined();
  });

  it('reads a snapshot in the shapes the provider prints', () => {
    expect(
      ticketSnapshot({
        status: 'In Progress',
        statusType: 'started',
        assignee: { id: 'user-key' },
        labels: { nodes: [{ name: 'Do not automate' }] },
      }),
    ).toEqual({
      assigned: true,
      assigneeId: 'user-key',
      state: 'In Progress',
      stateType: 'started',
      doNotAutomate: true,
    });
    expect(ticketSnapshot({ state: { name: 'Todo', type: 'unstarted' } })).toEqual(todo);
    // A colleague's address is kept only when no id identifies them.
    expect(
      ticketSnapshot({ assignee: { id: 'user-ana', email: 'ana@kestrel.test' }, status: 'Todo' }),
    ).toEqual({ assigned: true, assigneeId: 'user-ana', state: 'Todo', doNotAutomate: false });
  });

  it('names a change of hands, of state or a label since the listing the plan was made under', async () => {
    const owner = ownerRead();
    const context = { baseline: todo, owner: owner.read };
    await expect(ticketChange(todo, context)).resolves.toBeUndefined();
    await expect(
      ticketChange({ ...todo, assigned: true, assigneeId: 'user-ana' }, context),
    ).resolves.toBe('it changed hands: it is assigned to another person');
    await expect(
      ticketChange({ ...todo, state: 'In Progress', stateType: 'started' }, context),
    ).resolves.toBe('its state moved from Todo to In Progress');
    await expect(ticketChange({ ...todo, doNotAutomate: true }, context)).resolves.toBe(
      'it is labelled do-not-automate',
    );
    await expect(ticketChange({ ...todo, assigned: true }, context)).resolves.toBe(
      'it changed hands: it is assigned to a person Day0 cannot identify by id or email',
    );
  });

  it("keeps a ticket assigned since to the key's owner, and a state an earlier run set", async () => {
    const owner = ownerRead();
    await expect(
      ticketChange(
        { ...todo, assigned: true, assigneeEmail: 'ops@kestrel.test' },
        { baseline: todo, owner: owner.read },
      ),
    ).resolves.toBeUndefined();
    await expect(
      ticketChange(
        { ...todo, state: 'In Progress' },
        { baseline: todo, ownStates: ['in progress'], owner: owner.read },
      ),
    ).resolves.toBeUndefined();
    await expect(
      ticketChange(
        { ...todo, state: 'Done', stateType: 'completed' },
        { baseline: todo, ownStates: ['Done'], owner: owner.read },
      ),
    ).resolves.toBeUndefined();
    // The same assignee as the listing: the owner is never asked.
    const unasked = ownerRead();
    const mine = { ...todo, assigned: true, assigneeId: 'user-key' };
    await expect(
      ticketChange(mine, { baseline: mine, owner: unasked.read }),
    ).resolves.toBeUndefined();
    expect(unasked.calls()).toBe(0);
  });

  it("accepts a state any of the listing, a Retry since or Day0 itself left, and names the listing's when it moved", async () => {
    const owner = ownerRead();
    const inReview = { ...todo, state: 'In Review', stateType: 'started' };
    // Run 1 set In Progress; the plan was made under Todo; the manager retried once it read In Review.
    const context = {
      baseline: todo,
      acknowledged: inReview,
      ownStates: ['In Progress'],
      owner: owner.read,
    };
    await expect(ticketChange(inReview, context)).resolves.toBeUndefined();
    await expect(ticketChange({ ...todo, state: 'In Progress' }, context)).resolves.toBeUndefined();
    await expect(ticketChange({ ...todo, state: 'Blocked' }, context)).resolves.toBe(
      'its state moved from Todo to Blocked',
    );
    // An earlier run that set the state by id or by type: a type still matches, an id never names it.
    await expect(
      ticketChange(
        { ...todo, state: 'Done', stateType: 'completed' },
        { baseline: todo, ownStates: ['completed'], owner: owner.read },
      ),
    ).resolves.toBeUndefined();
    await expect(
      ticketChange(
        { ...todo, state: 'Done', stateType: 'completed' },
        { baseline: todo, ownStates: ['6f1c2a4e-0d3b-4c55-9a1e-7b2d8c9e0f11'], owner: owner.read },
      ),
    ).resolves.toBe('its state moved from Todo to Done');
    // A Retry acknowledges the state, never a person's assignment.
    await expect(
      ticketChange(
        { ...inReview, assigned: true, assigneeId: 'user-ana' },
        { ...context, acknowledged: { ...inReview, assigned: true, assigneeId: 'user-ana' } },
      ),
    ).resolves.toBe('it changed hands: it is assigned to another person');
  });

  it('applies the intake rule when there is no listing to compare with, and fails closed on an unread owner', async () => {
    await expect(ticketChange(todo, { owner: ownerRead().read })).resolves.toBeUndefined();
    await expect(
      ticketChange({ ...todo, state: 'Done', stateType: 'completed' }, { owner: ownerRead().read }),
    ).resolves.toBe('it is completed');
    await expect(
      ticketChange(
        { ...todo, assigned: true, assigneeId: 'user-key' },
        { owner: ownerRead('unread').read },
      ),
    ).resolves.toBe("it is assigned and the key's owner could not be read to confirm it is Day0's");
  });

  it('reads a null record under its key as no record, not as the wrapper around it (review M1)', () => {
    expect(recordFromText('{"issue":null}', 'issue')).toBeUndefined();
    expect(recordFromText('{"user":null}', 'user')).toBeUndefined();
    expect(recordFromText('{"issue":{"id":"iss-1","status":"Todo"}}', 'issue')).toEqual({
      id: 'iss-1',
      status: 'Todo',
    });
    expect(recordFromText('{"id":"iss-1","status":"Todo"}', 'issue')).toEqual({
      id: 'iss-1',
      status: 'Todo',
    });
  });

  it('refuses a record with neither a state nor an assignee, or one for another ticket (review M1)', () => {
    const ours = ['iss-1', 'REVOPS-9'];
    for (const text of ['{}', '{"success":true}', '{"error":"Entity not found: Issue"}']) {
      expect(ticketRecordRefusal(recordFromText(text, 'issue')!, ours)).toBe(
        'answered with neither a state nor an assignee',
      );
    }
    expect(
      ticketRecordRefusal({ id: 'iss-999', status: 'Todo', statusType: 'unstarted' }, ours),
    ).toBe('answered for another ticket (iss-999)');
    // Either of the ticket's names identifies it, whatever the case.
    expect(
      ticketRecordRefusal({ id: 'revops-9', uuid: 'f00d', status: 'Todo' }, ours),
    ).toBeUndefined();
    expect(ticketRecordRefusal({ identifier: 'REVOPS-9', assignee: null }, ours)).toBeUndefined();
    // A record that names no id is still compared by its fields.
    expect(ticketRecordRefusal({ assigneeId: 'user-ana' }, ours)).toBeUndefined();
  });

  it('lets a Retry excuse an open state it saw, never a do-not-automate label or a close (review M2)', async () => {
    const owner = ownerRead();
    const labelled = { ...todo, doNotAutomate: true };
    await expect(
      ticketChange(labelled, { baseline: todo, acknowledged: labelled, owner: owner.read }),
    ).resolves.toBe('it is labelled do-not-automate');
    const closed = { ...todo, state: 'Done', stateType: 'completed' };
    await expect(
      ticketChange(closed, { baseline: todo, acknowledged: closed, owner: owner.read }),
    ).resolves.toBe('its state moved from Todo to Done');
    const cancelled = { ...todo, state: "Won't do", stateType: 'canceled' };
    await expect(
      ticketChange(
        { ...cancelled, stateType: undefined },
        { baseline: todo, acknowledged: cancelled, owner: owner.read },
      ),
    ).resolves.toBe("its state moved from Todo to Won't do");
    const inReview = { ...todo, state: 'In Review', stateType: 'started' };
    await expect(
      ticketChange(inReview, { baseline: todo, acknowledged: inReview, owner: owner.read }),
    ).resolves.toBeUndefined();
    // A listing with no state type is no closed type: a Retry still clears the move.
    const untyped = { ...inReview, stateType: undefined };
    await expect(
      ticketChange(untyped, { baseline: todo, acknowledged: untyped, owner: owner.read }),
    ).resolves.toBeUndefined();
  });

  it('says nothing was sent only when the run sent nothing before the re-read held it (review M3)', () => {
    const withheld = withheldBeforeFirstWrite('iss-1', 'it is labelled do-not-automate');
    expect(withheld).toBe(
      'withheld before the first write: iss-1 changed since the plan was made: it is labelled do-not-automate.',
    );
    expect(ticketRereadStopReason(withheld, [])).toBe(`${withheld} Nothing was sent.`);
    expect(
      ticketRereadStopReason(withheld, [
        'http.request slack · POST /chat.postMessage',
        'mcp.call notion · update_page',
      ]),
    ).toBe(
      `${withheld} Sent before the re-read: http.request slack · POST /chat.postMessage; mcp.call notion · update_page.`,
    );
  });

  describe('under the app actor (D6, AC8)', () => {
    const APP_USER: PersonIdentity = { id: 'app-user-day0-leo' };
    const MANAGER = { id: 'user-ana', email: 'ana@kestrel.test' };

    it("holds a ticket by its delegate when one is set, else by its assignee: Linear's agent model", () => {
      // Assigning an issue to an app sets it as the delegate; the person stays the assignee.
      expect(
        ticketHolder({
          assigneeId: MANAGER.id,
          delegateId: 'APP-USER-DAY0-LEO',
          delegate: 'Day0 Leo',
        }),
      ).toEqual({ id: 'app-user-day0-leo', email: undefined });
      expect(
        ticketHolder({ assignee: { id: MANAGER.id }, delegate: { id: 'app-user-other' } }),
      ).toEqual({
        id: 'app-user-other',
        email: undefined,
      });
      expect(ticketHolder({ assigneeId: MANAGER.id })).toEqual({
        id: 'user-ana',
        email: undefined,
      });
      expect(ticketHolder({ delegate: null, assignee: null })).toBeUndefined();
    });

    it('snapshots the holder, so a ticket delegated to the app user at listing stays its own', async () => {
      const listed = ticketSnapshot({
        status: 'Todo',
        statusType: 'unstarted',
        assigneeId: MANAGER.id,
        delegateId: APP_USER.id,
      });
      expect(listed).toMatchObject({ assigned: true, assigneeId: 'app-user-day0-leo' });
      const appUser = ownerRead(APP_USER);

      await expect(
        ticketChange(listed, { baseline: listed, owner: appUser.read }),
      ).resolves.toBeUndefined();
    });

    it('takes a ticket delegated to the app user and leaves one assigned to the manager', async () => {
      const delegated = ticketSnapshot({
        statusType: 'unstarted',
        assigneeId: MANAGER.id,
        delegateId: APP_USER.id,
      });
      const managers = ticketSnapshot({ statusType: 'unstarted', assigneeId: MANAGER.id });

      await expect(
        ticketChange(delegated, { owner: ownerRead(APP_USER).read }),
      ).resolves.toBeUndefined();
      await expect(ticketChange(managers, { owner: ownerRead(APP_USER).read })).resolves.toBe(
        'it is assigned to another person',
      );
    });

    it('names a delegation taken away since the listing as a change of hands', async () => {
      const baseline = ticketSnapshot({
        statusType: 'unstarted',
        assigneeId: MANAGER.id,
        delegateId: APP_USER.id,
      });
      const now = ticketSnapshot({ statusType: 'unstarted', assigneeId: MANAGER.id });

      await expect(ticketChange(now, { baseline, owner: ownerRead(APP_USER).read })).resolves.toBe(
        'it changed hands: it is assigned to another person',
      );
    });

    it('reads the app user a card acts as from its probe, then from the landing, and never for a key', () => {
      expect(
        appIdentityOf({
          actsAs: { kind: 'own-app', label: 'Day0 Leo', providerIdentityId: 'app-user-landed' },
          providerIdentityId: 'APP-USER-PROBED',
        }),
      ).toEqual({ id: 'app-user-probed' });
      expect(
        appIdentityOf({
          actsAs: { kind: 'shared-app', label: 'Day0', providerIdentityId: 'app-user-day0-shared' },
        }),
      ).toEqual({ id: 'app-user-day0-shared' });
      expect(appIdentityOf({ actsAs: { kind: 'own-app', label: 'Day0 Leo' } })).toBeUndefined();
      expect(
        appIdentityOf({
          actsAs: { kind: 'shared-key', label: 'Ana key' },
          providerIdentityId: 'user-ana',
        }),
      ).toBeUndefined();
      expect(appIdentityOf({})).toBeUndefined();
    });
  });
});
