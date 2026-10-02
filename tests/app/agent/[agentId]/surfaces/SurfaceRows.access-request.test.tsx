/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccessRequestRow,
  accessRequestSentLines,
  type AccessRequestWords,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceRows';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, said, unmountAll } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
});

const REQUEST: AccessRequestWords = {
  reason: 'no-connection',
  text: 'Maya, a Day0 employee, needs access to Linear.',
  mailto: 'mailto:?subject=Day0%20access%20request',
};

/** The row mounted with its calls recorded in the order they were made. */
function mountRow(request: AccessRequestWords, refuse?: 'draft' | 'sent') {
  const calls: string[] = [];
  const view = mount(
    <AccessRequestRow
      request={request}
      system="Linear"
      employee="Maya"
      zone="UTC"
      dmReachable
      onDraft={vi.fn(async (): Promise<void> => {
        calls.push('draft');
        if (refuse === 'draft') throw new Error('That card no longer exists.');
      })}
      onSent={vi.fn(async (via: string): Promise<void> => {
        calls.push(`sent:${via}`);
      })}
      writeClipboard={async (text: string): Promise<void> => {
        calls.push(`clipboard:${text}`);
      }}
    />,
  );
  return { view, calls };
}

describe('the access request on the card (A24; the access plan, section 4.5)', (): void => {
  it('copies the words first, then drafts the request and records it copied', async (): Promise<void> => {
    const { view, calls } = mountRow(REQUEST);
    await press(view.container, 'Copy');
    expect(calls).toEqual([`clipboard:${REQUEST.text}`, 'draft', 'sent:copied']);
    expect(said(view.container)).toContain('Copied: paste it to IT.');
  });

  it('drafts the request when the manager sends it to themselves in Slack', async (): Promise<void> => {
    const { view, calls } = mountRow(REQUEST);
    await press(view.container, 'Send to me in Slack');
    expect(calls).toEqual(['draft']);
    expect(said(view.container)).toContain('Day0 is sending it to you in Slack.');
  });

  it('says a refusal beside the request and records nothing as sent', async (): Promise<void> => {
    const { view, calls } = mountRow(REQUEST, 'draft');
    await press(view.container, 'Send to me in Slack');
    expect(calls).toEqual(['draft']);
    expect(said(view.container)).toContain('That card no longer exists.');
  });

  it('keeps every control at 44 px and passes axe', async (): Promise<void> => {
    const { view } = mountRow(REQUEST);
    expect(underTarget(view.container)).toEqual([]);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
  });

  it('names the day it went to IT, the later of copied and emailed, and the day the DM landed', (): void => {
    expect(
      accessRequestSentLines(
        {
          copiedAt: Date.UTC(2026, 9, 2, 9),
          emailedAt: Date.UTC(2026, 9, 3, 9),
          messagedAt: Date.UTC(2026, 9, 2, 9),
        },
        'UTC',
      ),
    ).toEqual(['Sent to IT on 3 October', 'Sent to you in Slack on 2 October']);
    expect(accessRequestSentLines({}, 'UTC')).toEqual([]);
  });
});
