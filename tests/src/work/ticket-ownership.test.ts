import { describe, expect, it } from 'vitest';
import {
  samePerson,
  ticketAssignee,
  ticketChange,
  ticketSnapshot,
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
});
