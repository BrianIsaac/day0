/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  ACCESS_PERIODS,
  ExpiryBlock,
  type ExpirySurface,
} from '../../../../../app/agent/[agentId]/surfaces/ExpiryBlock';
import {
  SURFACE_ACCESS_DEFAULT_DAYS,
  SURFACE_ACCESS_MAX_DAYS,
} from '../../../../../src/surfaces/access';
import { AgentZoneContext } from '../../../../../app/components/time';
import { focusedName, mount, press, said } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

describe('the access line and its renewal (Q5, U3 D5)', (): void => {
  const AT = Date.UTC(2026, 8, 27, 16, 5, 9);
  const DAY = 24 * 60 * 60 * 1000;
  const surface = (patch: Partial<ExpirySurface>): ExpirySurface => ({
    _id: 'surface-linear' as Id<'surfaces'>,
    displayName: 'Linear',
    verdict: 'connected',
    expiresAt: AT,
    accessSetBy: 'approval',
    ...patch,
  });
  const renderAccess = (row: ExpirySurface, now: number): string =>
    renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <ExpiryBlock surface={row} now={now} onSetDays={async () => ({ expiresAt: AT })} />
      </AgentZoneContext>,
    ).replace(/&#x27;/g, "'");

  it('offers first the access length an approval gives, and no period the backend refuses (m25)', (): void => {
    const markup = renderAccess(surface({}), AT - 30 * DAY);
    expect(markup).toMatch(
      new RegExp(`<option value="${SURFACE_ACCESS_DEFAULT_DAYS}" selected="">`),
    );
    expect(ACCESS_PERIODS).toContain(SURFACE_ACCESS_DEFAULT_DAYS);
    expect(ACCESS_PERIODS.every((days) => days >= 1 && days <= SURFACE_ACCESS_MAX_DAYS)).toBe(true);
  });

  it("shows the end date in the employee's day, who set it, Q5's rule and the one renewal", (): void => {
    const markup = renderAccess(surface({}), AT - 30 * DAY);
    expect(markup).toContain('>Access lasts until</p>');
    expect(markup).toContain(
      '<time dateTime="2026-09-27T16:05:09.000Z">28 Sep 2026, 00:05</time> (set when you approved the card). A notice reaches you a week before. Renewing is your explicit act; a working probe never extends it.',
    );
    expect(markup).toMatch(/<select[^>]*>.*<option value="90" selected="">90 days<\/option>/);
    expect(markup).toMatch(/<button type="button" class="[^"]*">Renew for 90 days<\/button>/);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('set by the model');
  });

  it('offers no renewal on a card an administrator ended by revoking its connection, and says what brings it back (the pre-tag second pass)', (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext.Provider value="Asia/Singapore">
        <ExpiryBlock
          surface={surface({ reason: 'The docs server is being moved.' })}
          now={AT - 30 * DAY}
          onSetDays={vi.fn()}
          connectionRevoked
        />
      </AgentZoneContext.Provider>,
    );
    expect(markup).not.toMatch(/Renew for/);
    expect(markup).not.toContain('Access period');
    expect(markup).toContain(
      'IT revoked the organisation’s connection this card used, so renewing brings nothing back: it connects again once IT connects the system again.',
    );
  });

  it('warns from the day the week notice is due, and offers the renewal once access has ended', (): void => {
    const ending = renderAccess(surface({ accessSetBy: 'manager' }), AT - 2 * DAY);
    expect(ending).toContain(
      '(set by you). After that, nothing is read or sent through this card until you renew it.',
    );
    expect(ending).toContain('text-[var(--color-warn)]');
    const ended = renderAccess(
      surface({ verdict: 'approved', reason: 'expired', accessSetBy: 'upgrade' }),
      AT + DAY,
    );
    expect(ended).toContain('>Access ended</p>');
    expect(ended).toContain(
      '(set by the upgrade). Nothing is read or sent through this card until you renew it.',
    );
    expect(ended).toMatch(/>Renew for 90 days<\/button>/);
  });

  it('says access ended once the date has passed, before the sweep marks it and whatever reason a later failure left', (): void => {
    const markup = renderAccess(
      surface({
        verdict: 'ungranted',
        reason: 'BROWSER_DRIVER_ABSENT: the browser is not running',
      }),
      AT + 60_000,
    );
    expect(markup).toContain('>Access ended</p>');
    expect(markup).toMatch(/>Renew for 90 days<\/button>/);
    expect(markup).not.toContain('After that');
  });

  it('is absent before the card is approved, when access has not started', (): void => {
    expect(renderAccess(surface({ verdict: 'proposed', expiresAt: undefined }), AT)).toBe('');
    expect(renderAccess(surface({ verdict: 'declared' }), AT)).toBe('');
  });

  it('says a renewal, and says an earlier end as an earlier end, never as a renewal (review m10)', async (): Promise<void> => {
    const now = AT - 80 * DAY;
    const block = (expiresAt: number) =>
      mount(
        <AgentZoneContext value="UTC">
          <ExpiryBlock surface={surface({})} now={now} onSetDays={async () => ({ expiresAt })} />
        </AgentZoneContext>,
      );
    const later = block(now + 90 * DAY);
    await press(later.container, 'Renew for 90 days');
    expect(said(later.container)).toEqual(['Renewed: Linear access now ends 7 Oct 2026, 16:05.']);
    expect(focusedName()).toBe('Renew for 90 days');
    later.unmount();

    const earlier = block(now + 30 * DAY);
    await press(earlier.container, 'Renew for 90 days');
    expect(said(earlier.container)).toEqual([
      'Linear access now ends 8 Aug 2026, 16:05, earlier than it did.',
    ]);
    earlier.unmount();
  });
});

describe('what a renewal needs next, and the move off a pasted key (11-AR; A26, A27, RM4)', (): void => {
  const AT = Date.UTC(2026, 8, 27, 16, 5, 9);
  const DAY = 24 * 60 * 60 * 1000;
  const ended = (patch: Partial<ExpirySurface> = {}): ExpirySurface => ({
    _id: 'surface-slack' as Id<'surfaces'>,
    displayName: 'Slack',
    verdict: 'approved',
    reason: 'expired',
    expiresAt: AT,
    accessSetBy: 'approval',
    ...patch,
  });

  it("says, once a Slack own-app card's access ended, that its bot left its channels and what renewing restores", (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended()}
          now={AT + DAY}
          onSetDays={async () => ({ expiresAt: AT })}
          endedNote="Slack: Leo's bot is switched off and removed from its channels. Renewing turns it back on; it re-joins its public channels itself, and someone in each private channel adds it again."
        />
      </AgentZoneContext>,
    ).replace(/&#x27;/g, "'");
    expect(markup).toContain("Slack: Leo's bot is switched off and removed from its channels.");
    const running = renderToStaticMarkup(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended({ verdict: 'connected', reason: undefined })}
          now={AT - 30 * DAY}
          onSetDays={async () => ({ expiresAt: AT })}
          endedNote="Slack: the bot left."
        />
      </AgentZoneContext>,
    );
    expect(running).not.toContain('Slack: the bot left.');
  });

  it('says after a renewal that the identity the expiry revoked is issued again on the card', async (): Promise<void> => {
    const install = mount(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended()}
          now={AT + DAY}
          onSetDays={async () => ({ expiresAt: AT + 91 * DAY, reissue: 'install' as const })}
        />
      </AgentZoneContext>,
    );
    await press(install.container, 'Renew for 90 days');
    expect(said(install.container)).toEqual([
      'Renewed: Slack access now ends 27 Dec 2026, 16:05. The end revoked its access, so install its app again below.',
    ]);
    install.unmount();
    const authorise = mount(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended({ displayName: 'Linear' })}
          now={AT + DAY}
          onSetDays={async () => ({ expiresAt: AT + 91 * DAY, reissue: 'authorise' as const })}
        />
      </AgentZoneContext>,
    );
    await press(authorise.container, 'Renew for 90 days');
    expect(said(authorise.container)).toEqual([
      'Renewed: Linear access now ends 27 Dec 2026, 16:05. The end revoked its access, so Connect it again below.',
    ]);
    authorise.unmount();
  });

  it("offers a pasted-key card's move to its own identity at its renewal, and keeps the key working meanwhile (A27)", async (): Promise<void> => {
    const onMove = vi.fn();
    const view = mount(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended({ displayName: 'Linear', verdict: 'connected', reason: undefined })}
          now={AT - 2 * DAY}
          onSetDays={async () => ({ expiresAt: AT + 88 * DAY, offer: 'own-identity' as const })}
          move={{
            words:
              'IT connected Linear for your organisation: Maya can act as its own Linear app instead of the pasted key, which keeps working until you move.',
            label: 'Move off the pasted key',
            onMove,
          }}
        />
      </AgentZoneContext>,
    );
    expect(view.container.textContent).toContain('which keeps working until you move.');
    await press(view.container, 'Move off the pasted key');
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });

  it('offers no move while the access runs far from its end', (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="UTC">
        <ExpiryBlock
          surface={ended({ displayName: 'Linear', verdict: 'connected', reason: undefined })}
          now={AT - 60 * DAY}
          onSetDays={async () => ({ expiresAt: AT })}
          move={{
            words: 'IT connected Linear.',
            label: 'Move off the pasted key',
            onMove: (): void => undefined,
          }}
        />
      </AgentZoneContext>,
    );
    expect(markup).not.toContain('Move off the pasted key');
  });
});
