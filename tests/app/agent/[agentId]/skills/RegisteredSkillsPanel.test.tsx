/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { declareUndeclaredInputs } from '../../../../../src/work/skill-inputs';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import {
  RegisteredSkillsPanel,
  retryVerifiesSavedDraft,
} from '../../../../../app/agent/[agentId]/skills/RegisteredSkillsPanel';
import { button, focusedName, mount, press, said, settle } from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

/**
 * Render a panel in a document, have the named backend call refuse with the
 * transport's envelope around a message, click the named button and return the
 * attempts the panel filed.
 */
async function clickAndRecord(
  label: string,
  refusedCall: string,
  message: string,
  panel: (record: (attempt: unknown) => void) => React.ReactNode,
): Promise<unknown[]> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  backend.refusals = {
    [refusedCall]: `[CONVEX A(${refusedCall})] [Request ID: 1] Server Error\nUncaught Error: ${message}\n    at handler (../convex/x.ts:1:1)`,
  };
  const attempts: unknown[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act((): void => root.render(panel((attempt): void => void attempts.push(attempt))));
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async (): Promise<void> => {
      button?.click();
    });
    return attempts;
  } finally {
    act((): void => root.unmount());
    container.remove();
    backend.refusals = {};
  }
}

describe('what Retry does to an unregistered skill', (): void => {
  const noop = (): void => undefined;
  const base = {
    _id: 'skill-1',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'refresh-the-tile',
    description: 'refresh the analytics tile',
    sourceType: 'agent-authored',
    createdAt: 0,
  };
  const parked = {
    ...base,
    state: 'authoring',
    body: '# Refresh the tile\n## Inputs\n- analytics-surface: the tile',
    pendingSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
    verificationLog:
      'the verification sandbox was busy with another skill for 5 minutes; ' +
      'the body is kept and Retry runs the smoke test when it is free',
  } as unknown as Doc<'skills'>;
  const refused = {
    ...base,
    _id: 'skill-2',
    state: 'failed',
    body: '',
    verificationLog: 'the authored skill is not a reusable procedure: it repeats one item values',
  } as unknown as Doc<'skills'>;

  function panel(unregistered: Doc<'skills'>[]): string {
    return renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={unregistered}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
  }

  it('offers a parked skill the check it is waiting for, not a new authoring call', (): void => {
    const markup = panel([parked]);
    expect(markup).toContain('title="Run the body and smoke test this skill already has');
    expect(markup).not.toContain('Author this skill again');
  });

  it('files a refused Retry as the attempt, in the words written for a person', async (): Promise<void> => {
    const attempts = await clickAndRecord(
      'Retry with the reasons',
      'skillActions:authorAndRegisterSkill',
      'The sandbox component is not running.',
      (record) => (
        <RegisteredSkillsPanel
          skills={[]}
          unregistered={[refused]}
          authoringFailure={null}
          onAuthoringAttempt={record}
        />
      ),
    );
    expect(attempts).toEqual([
      null,
      {
        skillId: 'skill-2',
        name: 'refresh-the-tile',
        reason: 'The sandbox component is not running.',
      },
    ]);
  });

  /** What a production deployment sends for a plain `Error` thrown in the action: the envelope alone. */
  const REDACTED_AUTHORING =
    '[CONVEX A(skillActions:authorAndRegisterSkill)] [Request ID: 7f3a] Server Error';

  it('files a Retry the production backend redacted as a sentence, never the envelope', async (): Promise<void> => {
    backend.refusals = { 'skillActions:authorAndRegisterSkill': REDACTED_AUTHORING };
    const attempts: unknown[] = [];
    const view = mount(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[refused]}
        authoringFailure={null}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Retry with the reasons for refresh-the-tile');
    expect(attempts).toEqual([
      null,
      { skillId: 'skill-2', name: 'refresh-the-tile', reason: 'authoring did not finish' },
    ]);
    view.unmount();
    backend.refusals = {};
  });

  it('files a registered Retry as the attempt and gives focus back to Retry once its run lets go', async (): Promise<void> => {
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const attempts: unknown[] = [];
    const view = mount(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[refused]}
        authoringFailure={null}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Retry with the reasons for refresh-the-tile');
    expect(attempts).toEqual([null, { skillId: 'skill-2', name: 'refresh-the-tile' }]);
    expect(focusedName()).toBe('Retry with the reasons for refresh-the-tile');
    view.unmount();
    backend.results = {};
  });

  it('gives focus to the Skills card when a registered Retry takes its row out of the list', async (): Promise<void> => {
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const panel = (rows: Doc<'skills'>[]) => (
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={rows}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        focusRef={{ current: null }}
      />
    );
    const view = mount(panel([refused]));
    const retry = button(view.container, 'Retry with the reasons for refresh-the-tile');
    retry.focus();
    await act(async (): Promise<void> => {
      retry.click();
      // The row registers and leaves the list before the run's promise settles.
      view.root.render(panel([]));
    });
    await settle();
    expect(focusedName()).toBe('Registered');
    view.unmount();
    backend.results = {};
  });

  it('says a registration and an authoring failure in the Skills card live region, and gives each control a 44 px target', (): void => {
    const done = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[refused]}
        authoringFailure={null}
        registered="refresh-the-tile"
        onAuthoringAttempt={noop}
      />,
    );
    expect(done).toMatch(
      /<div role="status" aria-live="polite" aria-atomic="true"><p[^>]*>refresh-the-tile is registered: it passed the check and is callable\.<\/p><\/div>/,
    );
    expect(done).toMatch(
      /<button[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>Retry with the reasons<\/button>/,
    );
    const failed = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[]}
        authoringFailure="refresh-the-tile: the sandbox component is not running"
        onAuthoringAttempt={noop}
      />,
    );
    expect(failed).toMatch(/<div role="status"[^>]*><p[^>]*>Authoring did not finish: /);
  });

  it('offers a refused skill a fresh authoring call', (): void => {
    const markup = panel([refused]);
    expect(markup).toContain('title="Author this skill again, with the reason it stopped');
    expect(markup).not.toContain('already has');
  });

  it('authors again for a row whose run stopped before a smoke test was saved', (): void => {
    const interrupted = { ...parked, pendingSmokeTest: undefined } as unknown as Doc<'skills'>;
    expect(panel([interrupted])).toContain('title="Author this skill again');
    expect(retryVerifiesSavedDraft(parked)).toBe(true);
    expect(retryVerifiesSavedDraft(interrupted)).toBe(false);
    expect(retryVerifiesSavedDraft(refused)).toBe(false);
  });

  it('states both cases in the help text, keeping the sandbox and one-run-at-a-time rules', (): void => {
    const markup = panel([parked, refused]);
    expect(markup).not.toContain('Retry re-authors the skill');
    expect(markup).toContain('is checked again as it stands, with no second authoring call');
    expect(markup).toContain('is authored again, with the reason fed back');
    expect(markup).toContain('pnpm sandbox:up');
    expect(markup).toContain('DAYTONA_API_KEY');
    expect(markup).toContain('Only one authoring run holds a skill at a time');
  });

  // Rehearsal 1, 0:29: a traceback's caret line has no break opportunity, so
  // the column kept its full width and pushed Retry past the card's edge.
  it('lets the text column shrink beside Retry and wraps a log with no spaces, so Retry stays in the card', (): void => {
    const carets = '^'.repeat(56);
    const traceback = {
      ...refused,
      verificationLog: `verification in the local sandbox failed - smoke test exited 1. stderr: ${carets} AssertionError`,
    } as unknown as Doc<'skills'>;
    const markup = panel([traceback]);
    expect(markup).toMatch(
      /<div class="flex-1 min-w-0"><p[^>]*><span class="font-medium break-words">refresh-the-tile</,
    );
    expect(markup).toMatch(
      new RegExp(
        `<p class="[^"]*\\bbreak-words\\b[^"]*">verification in the local sandbox failed[^<]*\\^{56}`,
      ),
    );
  });

  it('says Ask for a revision writes a new version while this one keeps running', (): void => {
    const registered = {
      ...base,
      state: 'registered',
      body: '# Refresh',
    } as unknown as Doc<'skills'>;
    const markup = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[registered]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
    expect(markup).toContain(
      'title="Ask for a revision: a new version is written and checked in the sandbox, and this one keeps running until the new one registers"',
    );
    expect(markup).toContain('>Ask for a revision<');
  });

  it('writes the revision as its own row and leaves the registered one running', async (): Promise<void> => {
    backend.calls.length = 0;
    backend.results = {
      'skillControls:askForRevision': { revisionId: 'revision-1' },
      'skillActions:authorAndRegisterSkill': { ok: true },
    };
    const registered = {
      ...base,
      state: 'registered',
      body: '# Refresh',
    } as unknown as Doc<'skills'>;
    const attempts: unknown[] = [];
    const view = mount(
      <RegisteredSkillsPanel
        skills={[registered]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Ask for a revision of refresh-the-tile');
    expect(backend.calls).toEqual([
      { name: 'skillControls:askForRevision', args: { skillId: 'skill-1' } },
      { name: 'skillActions:authorAndRegisterSkill', args: { skillId: 'revision-1' } },
    ]);
    expect(attempts).toEqual([null, { skillId: 'revision-1', name: 'refresh-the-tile' }]);
    view.unmount();
    backend.results = {};
  });

  // The manager approves a skill before its body exists, so the skill's own
  // row is the first place its inputs can be shown, and it has to say which of
  // them the author never declared.
  describe('the inputs a skill declares, and which of them the system declared for its author', (): void => {
    const authored = declareUndeclaredInputs(
      [
        '# Close',
        '',
        '## Inputs',
        '',
        '- `<record-id>`: the ticket.',
        '',
        '## Procedure',
        '',
        'Set `<record-id>` to `<closing-state>`.',
      ].join('\n'),
    ).body;

    it('lists them on a registered skill and marks the one Day0 added, saying so', (): void => {
      const registered = {
        ...base,
        state: 'registered',
        body: authored,
      } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[registered]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
        />,
      );
      expect(markup).toMatch(/>inputs<\/span>[^&]*<code[^>]*>&lt;record-id&gt;<\/code>/);
      expect(markup).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
      // A placeholder never wraps inside its own name.
      expect(markup).toMatch(
        /<code class="[^"]*\bwhitespace-nowrap\b[^"]*">&lt;record-id&gt;<\/code>/,
      );
      expect(markup).toContain(
        'The author used the input marked “added by Day0” without declaring it',
      );
      expect(markup).toContain(
        'the executor reads it from the candidate or its runbook at run time',
      );
    });

    it('says nothing was added when the author declared everything, and nothing at all for a builtin', (): void => {
      const complete = {
        ...base,
        state: 'registered',
        body: '# Close\n\n## Inputs\n\n- `<record-id>`: the ticket.\n',
      } as unknown as Doc<'skills'>;
      const builtin = {
        ...complete,
        _id: 'skill-3',
        sourceType: 'builtin',
        body: '# See docs',
      } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[complete, builtin]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
        />,
      );
      expect(markup).toContain('&lt;record-id&gt;');
      expect(markup).not.toContain('added by Day0');
      expect(markup.match(/>inputs</g)).toHaveLength(1);
    });

    it('lists them on a failed attempt too, read from the draft the row kept', (): void => {
      const failed = { ...refused, body: '', refusedBody: authored } as unknown as Doc<'skills'>;
      expect(panel([failed])).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
    });
  });

  // Demo rehearsal 2, 19 Sep 2026, finding 1: a skill registered before
  // `<reply-surface>` was taught still runs, because the executor binds the
  // input for it in real mode; the inputs line says so.
  describe('the reply surface on the inputs line', (): void => {
    const before = [
      '# Close',
      '',
      '## Inputs',
      '',
      '- `<record-id>`: the ticket.',
      '- `<reply-channel>` and `<reply-thread>`: the Reply target line.',
      '',
      '## Procedure',
      '',
      'Comment on `<record-id>`, then reply to `<reply-channel>` in `<reply-thread>`.',
    ].join('\n');
    const taught = before.replace(
      '## Procedure',
      '- `<reply-surface>`: the chat surface.\n\n## Procedure',
    );
    const render = (body: string, surfaceMode?: 'mock' | 'real'): string =>
      renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[{ ...base, state: 'registered', body } as unknown as Doc<'skills'>]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
          surfaceMode={surfaceMode}
        />,
      );

    it('lists the input Day0 binds for a skill registered before it was taught, in real mode', (): void => {
      const markup = render(before, 'real');
      expect(markup).toMatch(
        /<code class="[^"]*\bwhitespace-nowrap\b[^"]*">&lt;reply-surface&gt;<\/code> \(bound by Day0\)/,
      );
      expect(markup).toContain(
        'This skill was registered before Day0 taught the input marked “bound by Day0”: the executor binds it from the Reply target, so the reply goes to the chat surface the ask came from.',
      );
    });

    it('says nothing of the kind on a failed attempt, which was never registered and is authored again on Retry', (): void => {
      const failed = { ...refused, body: '', refusedBody: before } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[]}
          unregistered={[failed]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
          surfaceMode="real"
        />,
      );
      expect(markup).toContain('&lt;reply-channel&gt;');
      expect(markup).not.toContain('bound by Day0');
    });

    it('lists it as the author declared it once taught, and adds nothing in mock mode', (): void => {
      expect(render(taught, 'real')).toContain('&lt;reply-surface&gt;');
      expect(render(taught, 'real')).not.toContain('bound by Day0');
      expect(render(before, 'mock')).not.toContain('reply-surface');
      expect(render(before)).not.toContain('reply-surface');
    });
  });

  // The author's open item 3: a traceback rendered as one run of text cannot be read on camera.
  describe('a verification log with line breaks', (): void => {
    const log = [
      'verification in the local sandbox (local:1f2e) failed - smoke test exited 1',
      '',
      'stderr:',
      'smoke harness: run() raised KeyError on case 2',
      '  File "authored_smoke.py", line 8, in run',
      "KeyError: 'closing-state'",
    ].join('\n');

    it('keeps its line breaks, in a box bounded in height that scrolls, still wrapping a line with no spaces', (): void => {
      const markup = panel([{ ...refused, verificationLog: log } as unknown as Doc<'skills'>]);
      const block =
        /<div tabindex="0" role="region" aria-label="Verification log: refresh-the-tile" class="([^"]*)" data-skill-log="multiline">([^<]*)<\/div>/.exec(
          markup,
        );
      // A scroll box is reachable from the keyboard and named, as axe's
      // scrollable-region-focusable asks (X2's siblings).
      expect(block).not.toBeNull();
      const classes = block![1]!.split(' ');
      expect(classes).toEqual(
        expect.arrayContaining([
          'whitespace-pre-wrap',
          'break-words',
          'max-h-40',
          'overflow-y-auto',
          'font-mono',
        ]),
      );
      expect(block![2]).toContain(
        'failed - smoke test exited 1\n\nstderr:\nsmoke harness: run() raised KeyError on case 2\n  File',
      );
    });

    it('leaves a one-line reason as the prose it was', (): void => {
      const markup = panel([refused]);
      expect(markup).not.toContain('data-skill-log="multiline"');
      expect(markup).toMatch(
        /<p class="[^"]*\bbreak-words\b[^"]*">the authored skill is not a reusable procedure/,
      );
    });
  });
  it('offers no Retry while a run is writing the skill, and says why', (): void => {
    const writing = {
      ...refused,
      state: 'authoring',
      authoringRunId: 'run-1',
      authoringClaimedAt: Date.now(),
    } as unknown as Doc<'skills'>;
    const markup = panel([writing]);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Retry refresh-the-tile"/);
    expect(markup).toContain('A run is writing this skill now; Retry opens once it finishes');
    expect(markup).toContain('>Being written<');
  });

  it('keeps the operator’s sandbox instructions behind a disclosure', (): void => {
    const markup = panel([refused]);
    expect(markup).toMatch(
      /What Retry does, and starting a sandbox<\/summary>[\s\S]*pnpm sandbox:up/,
    );
  });
});

describe('loading is not the same as empty (P3-13, moved from the work queue suite)', (): void => {
  it('says the skills are loading rather than empty', (): void => {
    const skills = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={() => undefined}
        loading={true}
      />,
    );
    expect(skills).toContain('loading skills…');
    expect(skills).not.toContain('none yet');
  });
});

describe('the five controls on the Skills cards (10-C, the prototype’s agent-skills.html)', (): void => {
  const noop = (): void => undefined;
  const authored = {
    _id: 'skill-1',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'kanban-comment-and-close',
    description: 'Comment on a ticket and close it.',
    body: '# Close',
    sourceType: 'agent-authored',
    state: 'registered',
    versionId: 'version-1',
    registeredAt: 1,
    useCount: 1,
    requiredScopes: ['linear:read', 'linear:write'],
    createdAt: 0,
  } as unknown as Doc<'skills'>;
  const due = {
    ...authored,
    recheckDueAt: 5,
    recheckReason: 'the tools you approved on linear changed',
  } as unknown as Doc<'skills'>;
  const failing = (attempts: number): Doc<'skills'> =>
    ({
      _id: `failing-${attempts}`,
      _creationTime: 0,
      agentId: 'agent-1',
      name: 'analytics-refresh-value',
      description: 'Refresh a tile.',
      body: '',
      sourceType: 'agent-authored',
      state: 'failed',
      authoringAttempts: attempts,
      verificationLog: 'the sandbox run refused the draft: an unclosed bracket',
      createdAt: 0,
    }) as unknown as Doc<'skills'>;

  function markupOf(skills: Doc<'skills'>[], unregistered: Doc<'skills'>[] = []): string {
    return renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={skills}
        unregistered={unregistered}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        employee="Mira"
      />,
    );
  }

  it('says how often each skill was used, a built-in one included', (): void => {
    const builtin = {
      ...authored,
      _id: 'builtin-1',
      name: 'see-internal-docs',
      sourceType: 'builtin',
      useCount: 3,
    } as unknown as Doc<'skills'>;
    const twice = { ...authored, useCount: 2 } as unknown as Doc<'skills'>;
    const never = { ...authored, useCount: undefined } as unknown as Doc<'skills'>;
    expect(markupOf([authored])).toContain(' · used 1 time · ');
    expect(markupOf([twice])).toContain(' · used 2 times · ');
    expect(markupOf([never])).toContain(' · not used yet · ');
    expect(markupOf([builtin])).toContain(' · used 3 times · ');
    // A built-in skill comes with the employee: none of the controls is drawn on it.
    expect(markupOf([builtin])).not.toContain('Retire');
  });

  it('draws Re-check due with its reason and Re-check now, and only on a skill that is due', async (): Promise<void> => {
    expect(markupOf([authored])).not.toContain('Re-check');
    const markup = markupOf([due]);
    expect(markup).toContain('>Re-check due<');
    expect(markup).toContain(
      'The tools you approved on linear changed. Mira keeps running the verified version until it is re-checked.',
    );
    expect(markup).toContain('>Re-check now<');
    expect(markup).toContain('>Ask for a revision<');
    expect(markup).toContain('>Retire<');

    backend.calls.length = 0;
    backend.results = { 'skillControls:recheckNow': { scheduled: true } };
    const view = mount(
      <RegisteredSkillsPanel
        skills={[due]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        employee="Mira"
      />,
    );
    await press(view.container, 'Re-check kanban-comment-and-close now');
    expect(backend.calls).toEqual([
      { name: 'skillControls:recheckNow', args: { skillId: 'skill-1' } },
    ]);
    expect(said(view.container)).toContain(
      'kanban-comment-and-close is being re-checked in the sandbox; it keeps running meanwhile.',
    );
    view.unmount();
    backend.results = {};
  });

  it('says a re-check is running instead of offering another', (): void => {
    const checking = {
      ...due,
      authoringRunId: 'run-1',
      authoringClaimedAt: Date.now(),
    } as unknown as Doc<'skills'>;
    const markup = markupOf([checking]);
    expect(markup).toContain('>Re-checking<');
    expect(markup).not.toContain('>Re-check due<');
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Re-check kanban-comment-and-close now"/,
    );
  });

  it('draws a revision running beside the old version, and asks for no second one', (): void => {
    const revision = {
      ...failing(1),
      _id: 'revision-1',
      name: 'kanban-comment-and-close',
      state: 'approved',
      verificationLog: undefined,
      authoringAttempts: undefined,
      revisionOf: 'skill-1',
    } as unknown as Doc<'skills'>;
    const markup = markupOf([authored], [revision]);
    expect(markup).toContain(
      'A revision is being written. Mira keeps running this version until the new one registers.',
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Ask for a revision of kanban-comment-and-close"/,
    );
    expect(markup).toContain('>revision<');
    expect(markup).toContain(
      'A revision of a registered skill. Mira keeps running the registered version until this one registers.',
    );
  });

  it('counts the attempt a failed draft is on, with Retry with the reasons and Give up', async (): Promise<void> => {
    const markup = markupOf([], [failing(2)]);
    expect(markup).toContain('>Attempt 2 of 3<');
    expect(markup).toContain('>Retry with the reasons<');
    expect(markup).toContain('>Give up<');

    backend.calls.length = 0;
    backend.results = { 'skillControls:giveUp': { givenUp: true, cancelled: 1 } };
    const view = mount(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[failing(2)]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        employee="Mira"
      />,
    );
    await press(view.container, 'Give up analytics-refresh-value');
    expect(backend.calls).toEqual([
      { name: 'skillControls:giveUp', args: { skillId: 'failing-2' } },
    ]);
    expect(said(view.container)).toContain(
      'analytics-refresh-value is given up; 1 waiting item is cancelled.',
    );
    view.unmount();
    backend.results = {};
  });

  it('the third failed attempt withdraws Retry and leaves Give up', (): void => {
    const markup = markupOf([], [failing(3)]);
    expect(markup).toContain('>Attempt 3 of 3<');
    expect(markup).not.toContain('Retry with the reasons<');
    expect(markup).not.toMatch(/aria-label="Retry[^"]*analytics-refresh-value"/);
    expect(markup).toContain('>Give up<');
    expect(markup).toContain(
      'All 3 attempts failed, so Retry is withdrawn. Give up ends the skill and cancels the work waiting for it, with the reason.',
    );
  });

  it('opens the Retire dialog, closes it on Keep, and says the retire once it lands', async (): Promise<void> => {
    backend.queries = {
      'skillVersions:forSkill': {
        held: {
          version: { _id: 'version-1', version: 1 },
          holders: [
            { skillId: 'skill-1', agentId: 'agent-1', agentName: 'Mira', state: 'registered' },
          ],
        },
        offered: null,
      },
    };
    backend.results = { 'skillControls:retire': { retired: true, returnedItems: 0 } };
    const card = { current: null as HTMLElement | null };
    const view = mount(
      <RegisteredSkillsPanel
        skills={[authored]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        employee="Mira"
        focusRef={card}
      />,
    );
    await press(view.container, 'Retire kanban-comment-and-close');
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    await press(document.body, 'Keep it');
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(focusedName()).toBe('Retire kanban-comment-and-close');

    await press(view.container, 'Retire kanban-comment-and-close');
    await press(document.body, 'Retire from Mira');
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toContain('kanban-comment-and-close is retired from Mira.');
    view.unmount();
    backend.queries = {};
    backend.results = {};
  });
});
