/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  dismissWhy,
  RejectedSection,
  retryWhy,
  RetrySection,
  SkippedSection,
  type RetryMode,
} from '../../../../../app/agent/[agentId]/work/RetrySection';
import { DRAWN, ZONE, minute } from '../../../../fixtures/work/drawn-states';
import { button, mount, typeInto } from '../../../../fixtures/dom/press';

const MODES: RetryMode[] = [
  { kind: 'send-back' },
  { kind: 'answer', question: 'Which template?' },
  { kind: 'retry-failed', rejected: true },
  { kind: 'retry-failed', rejected: false },
  { kind: 'cancelled', hadPlan: true },
  { kind: 'cancelled', hadPlan: false },
  { kind: 'take', waived: 'scope' },
  { kind: 'take', waived: 'quality-fit' },
  { kind: 'skip-retry' },
  { kind: 'parked' },
];

describe('what each settling control does', (): void => {
  it('says it for every mode, naming the employee, and never promises an approval', (): void => {
    for (const mode of MODES) {
      const why = retryWhy(mode, 'Mira', false);
      expect(why.length).toBeGreaterThan(20);
      expect(why).not.toMatch(/approves? (it|the writes)/);
    }
    expect(retryWhy({ kind: 'retry-failed', rejected: true }, 'the employee', false)).toMatch(
      /^The employee runs the approved plan again/,
    );
    expect(retryWhy({ kind: 'send-back' }, 'Mira', true)).toContain(
      'the writes the gate allows apply on their own',
    );
  });

  it('says a retry reads the note in place of the reason, never both (retryFailed keeps one)', (): void => {
    expect(retryWhy({ kind: 'retry-failed', rejected: true }, 'Mira', false)).toBe(
      'Mira runs the approved plan again, reading your note as direction when you write one and your reason when you do not. A note can change what is proposed; it cannot approve anything, and when it finishes, reads and messages to you apply on their own, and every other write waits for your approval.',
    );
    expect(retryWhy({ kind: 'cancelled', hadPlan: true }, 'Mira', false)).toBe(
      'Retry drafts a new plan from your note when you write one, and from your reason when you do not; the plan comes back to you before anything runs.',
    );
    expect(retryWhy({ kind: 'parked' }, 'Mira', false)).not.toContain('Retry sends it back');
    expect(retryWhy({ kind: 'send-back' }, 'Mira', false, 'mock')).toContain(
      'every write waits for your approval',
    );
  });

  it('says what Dismiss does, which a rejection already half did', (): void => {
    expect(dismissWhy({ kind: 'retry-failed', rejected: true })).toContain(
      'already out of your inbox',
    );
    expect(dismissWhy({ kind: 'retry-failed', rejected: false })).toBe(
      'Dismiss takes it out of your inbox and keeps it in the record; Retry stays here.',
    );
  });
});

describe('a skip and a rejection, drawn', (): void => {
  it('says a scope skip is judged apart from a skill, and a plain skip without it', (): void => {
    const scope = renderToStaticMarkup(
      <SkippedSection reason="out-of-scope: finance close work" scope employeeName="Mira" />,
    );
    expect(scope).toContain('Skipped.</span> Finance close work.');
    expect(scope).toContain('judged separately from whether Mira has a skill for it');
    expect(
      renderToStaticMarkup(
        <SkippedSection reason="low-value: 10" scope={false} employeeName="Mira" />,
      ),
    ).not.toContain('judged separately');
  });

  it('says what had landed on its own when a rejection came after it', (): void => {
    const markup = renderToStaticMarkup(
      <RejectedSection
        rejection={{ reason: '', at: minute(22) }}
        landed={2}
        notSent={[]}
        zone={ZONE}
      />,
    );
    expect(markup).toContain('Nothing held was sent; 2 changes had already landed on their own');
    expect(markup).toContain('You gave no reason.');
    expect(markup).not.toContain('What was held and not sent');
  });
});

describe('the settling controls', (): void => {
  it('holds Answer and retry until an answer is typed, the field labelled with the question', (): void => {
    const view = mount(
      <RetrySection
        item={DRAWN.rejected}
        mode={{ kind: 'answer', question: 'Which template?' }}
        reconciliation={{ needed: false, entries: [] }}
        employeeName="Mira"
        autonomous={false}
        busy={false}
        onRetry={(): void => undefined}
        onReconcile={(): void => undefined}
      />,
    );
    expect(() => button(view.container, 'Answer and retry')).toThrow();
    const label = [...view.container.querySelectorAll('label')].find(
      (candidate) => candidate.textContent === 'Your answer to: “Which template?”',
    );
    typeInto(label?.control as HTMLInputElement, 'The exception template.');
    expect(button(view.container, 'Answer and retry')).toBeTruthy();
    view.unmount();
  });

  it('offers Dismiss beside Retry until the item is dismissed, then says when it was', (): void => {
    const open = renderToStaticMarkup(
      <RetrySection
        item={DRAWN.rejected}
        mode={{ kind: 'retry-failed', rejected: true }}
        reconciliation={{ needed: false, entries: [] }}
        employeeName="Mira"
        autonomous={false}
        busy={false}
        onRetry={(): void => undefined}
        onReconcile={(): void => undefined}
        dismiss={{ kind: 'dismiss', onDismiss: (): void => undefined }}
      />,
    );
    expect(open).toMatch(/>Retry<\/button><button[^>]*>Dismiss<\/button>/);
  });
});
