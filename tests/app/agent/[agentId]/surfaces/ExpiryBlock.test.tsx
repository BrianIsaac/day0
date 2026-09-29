/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  ExpiryBlock,
  type ExpirySurface,
} from '../../../../../app/agent/[agentId]/surfaces/ExpiryBlock';
import { AgentZoneContext } from '../../../../../app/agent/[agentId]/time';
import { focusedName, mount, press, said } from '../../../../fixtures/dom/press';

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
