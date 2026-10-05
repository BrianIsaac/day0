import { describe, expect, it } from 'vitest';
import { createLinear } from '../../fake-linear/linear.js';
import {
  AUTHORISE_SCOPES_NOT_VALID_FOR_ACTOR,
  CONSENT_LINES,
} from '../fixtures/linear/linear-walks-2026-10-03';
import { LEO, REDIRECT, authoriseUrl, call, consent, linear, pkce, viewer } from './double';

describe('the fake Linear authorise page', (): void => {
  it("shows the app's consent in the walks' words, with one Authorize button", async (): Promise<void> => {
    const answer = await call(linear(), authoriseUrl(LEO, pkce().challenge));
    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('text/html; charset=utf-8');
    expect(answer.text).toContain(`Leo (Day0) ${CONSENT_LINES[0]}`);
    let from = 0;
    for (const line of CONSENT_LINES) {
      const at = answer.text.indexOf(line, from);
      expect(at, line).toBeGreaterThanOrEqual(from);
      from = at;
    }
    expect(answer.text.match(/value="authorize"/g)).toHaveLength(1);
  });

  it('redirects one click back to the callback with the code and the state', async (): Promise<void> => {
    const { code, location } = await consent(linear(), authoriseUrl(LEO, pkce().challenge));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('signed-state');
    expect(code).toMatch(/^lin_code_fake_/);
  });

  it("refuses app:assignable without actor=app in Linear's words (R41V, the person's token, (a))", async (): Promise<void> => {
    const answer = await call(linear(), authoriseUrl(LEO, pkce().challenge, { actor: null }));
    expect(answer.text).toContain(AUTHORISE_SCOPES_NOT_VALID_FOR_ACTOR);
  });

  it("issues a person's token when the link asks for no app actor (R41V, (b))", async (): Promise<void> => {
    const fake = linear();
    const { verifier, challenge } = pkce();
    const { code } = await consent(
      fake,
      authoriseUrl(LEO, challenge, { actor: null, scope: 'read,write' }),
    );
    const exchanged = await call(fake, 'https://api.linear.app/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: LEO.clientId,
        client_secret: LEO.clientSecret,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    const token = (exchanged.body as { access_token: string }).access_token;
    expect((await viewer(fake, token)).body).toEqual({
      data: { viewer: { id: expect.any(String), name: 'Sam', app: false } },
    });
  });

  it('installs the app user at the consent, before any code is exchanged (the re-walk, row 2)', async (): Promise<void> => {
    const fake = linear();
    await consent(fake, authoriseUrl(LEO, pkce().challenge));
    expect(fake.workspace.appUsers.get(LEO.clientId)).toMatchObject({
      name: 'Leo (Day0)',
      app: true,
    });
  });

  it('refuses an app actor install by a member who is not an administrator (L1, documented)', async (): Promise<void> => {
    const fake = createLinear({ apps: [LEO], signedIn: 'ana@acme.test' });
    const answer = await call(fake, 'https://linear.app/oauth/authorize', {
      form: {
        ...Object.fromEntries(new URL(authoriseUrl(LEO, pkce().challenge)).searchParams),
        decision: 'authorize',
      },
    });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('Admin permissions are required');
  });

  it('refuses a challenge method other than S256 before it installs anything', async (): Promise<void> => {
    const fake = linear();
    const link = authoriseUrl(LEO, pkce().challenge, { code_challenge_method: 'plain' });
    const answer = await call(fake, 'https://linear.app/oauth/authorize', {
      form: { ...Object.fromEntries(new URL(link).searchParams), decision: 'authorize' },
    });
    expect(answer.status).toBe(400);
    expect(fake.workspace.appUsers.get(LEO.clientId)).toBeUndefined();
  });

  it('takes the consent only from the posted form: a link carrying the decision shows the page', async (): Promise<void> => {
    const answer = await call(
      linear(),
      authoriseUrl(LEO, pkce().challenge, { decision: 'authorize' }),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('location')).toBeNull();
  });

  it('refuses a redirect the app does not register', async (): Promise<void> => {
    const answer = await call(
      linear(),
      authoriseUrl(LEO, pkce().challenge, { redirect_uri: 'https://elsewhere.test/callback' }),
    );
    expect(answer.status).toBe(400);
    expect(answer.headers.get('location')).toBeNull();
  });
});
