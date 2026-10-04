import { describe, expect, it } from 'vitest';
import {
  VIEWER_OF_API_KEY,
  VIEWER_UNAUTHENTICATED,
} from '../fixtures/linear/linear-oauth-2026-10-02';
import {
  APP_USER_LACKS_CAPABILITY,
  DELEGATE_MUTATION,
  DELEGATE_TO_SHARED_APP_200,
  GRAPHQL_NOT_AUTHENTICATED_401,
  LINEAR_JSON_CONTENT_TYPE,
  WALK_KEY_PERSON_ID,
  WALK_SHARED_APP_USER,
} from '../fixtures/linear/linear-walks-2026-10-03';
import { createLinear } from '../../fake-linear/linear.js';
import type { FakeLinear } from '../../fake-linear/linear';
import { LEO, SAM_KEY, SHARED, appActorToken, call, revoke, type Answer } from './double';

const GRAPHQL = 'https://api.linear.app/graphql';

/** The double with the walks' key person as its administrator and a REVOPS team numbered as the re-walk's. */
function walkWorkspace(): FakeLinear {
  return createLinear({
    apps: [SHARED, LEO],
    people: [
      {
        id: WALK_KEY_PERSON_ID,
        name: VIEWER_OF_API_KEY.data.viewer.name,
        displayName: 'sam',
        email: VIEWER_OF_API_KEY.data.viewer.email,
        admin: true,
        apiKey: SAM_KEY,
      },
    ],
    workspace: {
      teams: [{ key: 'REVOPS', name: 'RevOps', issueCount: 36 }],
      projects: [{ name: 'Q3 close', team: 'REVOPS' }],
    },
  });
}

async function graphql(
  fake: FakeLinear,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Answer> {
  return await call(fake, GRAPHQL, { bearer: token, json: { query, variables } });
}

/** File a ticket with the bed key, as the walks did, assigned to the key's person. */
async function fileTicket(fake: FakeLinear): Promise<{ id: string; identifier: string }> {
  const teams = await graphql(fake, SAM_KEY, '{ teams { nodes { id key } } }');
  const teamId = (teams.body as { data: { teams: { nodes: { id: string }[] } } }).data.teams
    .nodes[0]!.id;
  const created = await graphql(
    fake,
    SAM_KEY,
    'mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }',
    {
      input: {
        teamId,
        title: '[w11 re-walk] Row 1: delegated to the shared Day0 app',
        assigneeId: WALK_KEY_PERSON_ID,
      },
    },
  );
  return (created.body as { data: { issueCreate: { issue: { id: string; identifier: string } } } })
    .data.issueCreate.issue;
}

describe('the fake Linear GraphQL API', (): void => {
  it("answers viewer with a person's API key as that person, app false (recorded 2 October)", async (): Promise<void> => {
    const answer = await graphql(walkWorkspace(), SAM_KEY, '{ viewer { id name email app } }');
    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe(LINEAR_JSON_CONTENT_TYPE);
    expect(answer.body).toEqual(VIEWER_OF_API_KEY);
  });

  it('accepts a personal API key sent bare in the Authorization header, as Linear documents', async (): Promise<void> => {
    const answer = await walkWorkspace().handle(
      new Request(GRAPHQL, {
        method: 'POST',
        headers: { authorization: SAM_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { name } }' }),
      }),
    );
    expect(await answer.json()).toEqual({ data: { viewer: { name: 'Sam' } } });
  });

  it('refuses a token it does not hold with the body the re-walk logged, under 401', async (): Promise<void> => {
    const answer = await graphql(walkWorkspace(), 'lin_oauth_never_issued', '{ viewer { id } }');
    expect(answer.status).toBe(GRAPHQL_NOT_AUTHENTICATED_401.status);
    expect(answer.body).toEqual(GRAPHQL_NOT_AUTHENTICATED_401.body);
    expect(answer.text).toContain(JSON.parse(VIEWER_UNAUTHENTICATED.body).errors[0].message);
  });

  it('answers a viewer read with more fields as the walk read the app user (displayName, address)', async (): Promise<void> => {
    const fake = walkWorkspace();
    const answer = await graphql(
      fake,
      await appActorToken(fake),
      '{ viewer { id name displayName app email } }',
    );
    expect(answer.body).toEqual({
      data: {
        viewer: {
          id: WALK_SHARED_APP_USER.id,
          name: 'Day0',
          displayName: 'day0',
          app: true,
          email: expect.stringMatching(/@oauthapp\.linear\.app$/),
        },
      },
    });
  });

  it("refuses a delegate to the app user with no live app:assignable token, in the walk's words (decision 5, step 1)", async (): Promise<void> => {
    const fake = walkWorkspace();
    await appActorToken(fake, 'read,write');
    const ticket = await fileTicket(fake);
    const answer = await graphql(fake, SAM_KEY, DELEGATE_MUTATION, {
      id: ticket.id,
      delegateId: WALK_SHARED_APP_USER.id,
    });
    // The status was not logged ("400 in-band"); 400 is the fake's, as R-W's bed answered it.
    expect(answer.status).toBe(400);
    const [error] = (
      answer.body as { errors: { message: string; extensions: Record<string, unknown> }[] }
    ).errors;
    expect(error?.message).toBe(APP_USER_LACKS_CAPABILITY.message);
    expect(error?.extensions).toMatchObject({
      code: APP_USER_LACKS_CAPABILITY.code,
      userPresentableMessage: APP_USER_LACKS_CAPABILITY.userPresentableMessage,
    });
    const read = await graphql(fake, SAM_KEY, '{ issue(id: "REVOPS-37") { delegate { id } } }');
    expect(read.body).toEqual({ data: { issue: { delegate: null } } });
  });

  it('refuses it as the assignee in the same words', async (): Promise<void> => {
    const fake = walkWorkspace();
    await appActorToken(fake, 'read,write');
    const ticket = await fileTicket(fake);
    const answer = await graphql(
      fake,
      SAM_KEY,
      'mutation { issueUpdate(id: "' +
        ticket.id +
        '", input: { assigneeId: "' +
        WALK_SHARED_APP_USER.id +
        '" }) { success } }',
    );
    expect(answer.text).toContain(APP_USER_LACKS_CAPABILITY.userPresentableMessage);
  });

  it('still refuses once the app:assignable token was revoked before the delegate (decision 5, step 2)', async (): Promise<void> => {
    const fake = walkWorkspace();
    const assignable = await appActorToken(fake, 'read,write,app:assignable');
    await revoke(fake, assignable);
    const ticket = await fileTicket(fake);
    const answer = await graphql(fake, SAM_KEY, DELEGATE_MUTATION, {
      id: ticket.id,
      delegateId: WALK_SHARED_APP_USER.id,
    });
    expect(answer.text).toContain(APP_USER_LACKS_CAPABILITY.userPresentableMessage);
  });

  it('delegates to the app user while an app:assignable token lives, as the re-walk logged it (row 1)', async (): Promise<void> => {
    const fake = walkWorkspace();
    await appActorToken(fake, 'read,write,app:assignable');
    const ticket = await fileTicket(fake);
    expect(ticket.identifier).toBe('REVOPS-37');
    const answer = await graphql(fake, SAM_KEY, DELEGATE_MUTATION, {
      id: ticket.id,
      delegateId: WALK_SHARED_APP_USER.id,
    });
    expect(answer.status).toBe(DELEGATE_TO_SHARED_APP_200.status);
    expect(answer.body).toEqual(DELEGATE_TO_SHARED_APP_200.body);
  });

  it('lists the app users while their tokens live (decision 5, step 3)', async (): Promise<void> => {
    const fake = walkWorkspace();
    await appActorToken(fake);
    const answer = await graphql(
      fake,
      SAM_KEY,
      '{ users(filter: { app: { eq: true } }) { nodes { id name } } }',
    );
    expect(answer.body).toEqual({
      data: { users: { nodes: [{ id: WALK_SHARED_APP_USER.id, name: 'Day0' }] } },
    });
  });

  it('reads back a comment, a state change and an archive with their authors (W-L6, W-L12)', async (): Promise<void> => {
    const fake = walkWorkspace();
    const ticket = await fileTicket(fake);
    const states = await graphql(fake, SAM_KEY, '{ workflowStates { nodes { id name } } }');
    const done = (
      states.body as { data: { workflowStates: { nodes: { id: string; name: string }[] } } }
    ).data.workflowStates.nodes.find((state) => state.name === 'Done');
    await graphql(
      fake,
      SAM_KEY,
      `mutation { commentCreate(input: { issueId: "${ticket.identifier}", body: "Done." }) { success } }`,
    );
    await graphql(
      fake,
      SAM_KEY,
      `mutation { issueUpdate(id: "${ticket.id}", input: { stateId: "${done?.id}" }) { success } }`,
    );
    const archived = await graphql(
      fake,
      SAM_KEY,
      `mutation { issueArchive(id: "${ticket.id}") { success } }`,
    );
    expect(archived.body).toEqual({ data: { issueArchive: { success: true } } });
    const read = await graphql(
      fake,
      SAM_KEY,
      `{ issue(id: "${ticket.identifier}") { state { name } trashed archivedAt comments { nodes { body user { name app } } } history { nodes { actor { name } fromState { name } toState { name } } } } }`,
    );
    expect(read.body).toEqual({
      data: {
        issue: {
          state: { name: 'Done' },
          trashed: null,
          archivedAt: expect.any(String),
          comments: { nodes: [{ body: 'Done.', user: { name: 'Sam', app: false } }] },
          history: {
            nodes: [
              { actor: { name: 'Sam' }, fromState: { name: 'Backlog' }, toState: { name: 'Done' } },
            ],
          },
        },
      },
    });
  });

  it('leaves a field alone when its variable is not sent, as GraphQL reads an absent variable', async (): Promise<void> => {
    const fake = walkWorkspace();
    const ticket = await fileTicket(fake);
    await graphql(
      fake,
      SAM_KEY,
      'mutation ($id: String!, $assigneeId: String) { issueUpdate(id: $id, input: { assigneeId: $assigneeId, title: "Renamed" }) { success } }',
      { id: ticket.id },
    );
    const read = await graphql(
      fake,
      SAM_KEY,
      `{ issue(id: "${ticket.id}") { title assignee { id } } }`,
    );
    expect(read.body).toEqual({
      data: { issue: { title: 'Renamed', assignee: { id: WALK_KEY_PERSON_ID } } },
    });
  });

  it('writes nothing for a mutation whose selection names a field its type does not have', async (): Promise<void> => {
    const fake = walkWorkspace();
    const ticket = await fileTicket(fake);
    const answer = await graphql(
      fake,
      SAM_KEY,
      `mutation { issueUpdate(id: "${ticket.id}", input: { title: "Changed" }) { success issue { shoeSize } } }`,
    );
    expect(answer.status).toBe(400);
    const read = await graphql(fake, SAM_KEY, `{ issue(id: "${ticket.id}") { title } }`);
    expect(read.body).toEqual({
      data: { issue: { title: '[w11 re-walk] Row 1: delegated to the shared Day0 app' } },
    });
  });

  it('refuses a field the type does not have, as a GraphQL validation failure', async (): Promise<void> => {
    const answer = await graphql(walkWorkspace(), SAM_KEY, '{ viewer { id shoeSize } }');
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('Cannot query field \\"shoeSize\\" on type \\"User\\".');
  });

  it('answers a bare GET with 400, as the backend reach check saw (the re-walk, install)', async (): Promise<void> => {
    expect((await call(walkWorkspace(), GRAPHQL)).status).toBe(400);
  });
});
