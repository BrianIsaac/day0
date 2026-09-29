'use client';

import type { Doc, Id } from '@convex/_generated/dataModel';
import { type AuthoringAttempt, AUTHORING_UNFINISHED } from './authoring';
import { useAction, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useState, useId, useEffect } from 'react';
import { useNow } from '../time';
import { refusalText, returnFocus } from '../../../components/use-change';
import { Card } from '../../../components/Card';
import { holdsLiveAuthoringClaim } from '@/lib/skill-authoring';
import { declaredSkillInputs, impliedSkillInputs, systemDeclaredInputs } from '@/work/skill-inputs';
import { DISCLOSURE_SUMMARY } from '../../../components/Disclosure';

/**
 * Whether Retry on this row verifies the draft it already has rather than
 * authoring a new one.
 *
 * A skill parked because the sandbox was busy or unavailable keeps the body
 * and smoke test that were authored and passed the static gate, so its retry
 * runs the check on them with no second model call. The condition is the one
 * `convex/skillActions.ts` acts on, so the button says what the backend will
 * do; every other row - a refusal, a smoke test the sandbox turned down, a run
 * that stopped before its draft was saved - has no draft to verify.
 *
 * Args:
 *   skill: The unregistered skill row the panel is listing.
 *
 * Returns:
 *   True when Retry verifies the saved draft without authoring again.
 */
export function retryVerifiesSavedDraft(
  skill: Pick<Doc<'skills'>, 'state' | 'body' | 'pendingSmokeTest'>,
): boolean {
  return skill.state === 'authoring' && Boolean(skill.body) && Boolean(skill.pendingSmokeTest);
}

/** The registered skills and the ones waiting on a grant, with the author's attempts. */
export function RegisteredSkillsPanel({
  skills,
  unregistered,
  authoringFailure,
  registered = null,
  onAuthoringAttempt,
  surfaceMode,
  focusRef,
  loading = false,
}: {
  skills: Doc<'skills'>[];
  /** The registered skills' query has not answered yet. */
  loading?: boolean;
  /**
   * Authored but never registered: `authoring` (a run is holding it now, or no
   * sandbox ran), `failed` (the sandbox said no), and `verified` (registration
   * was interrupted before the lifecycle was collapsed into one mutation).
   * A skill a run holds is listed here throughout, so a run that dies mid-flight
   * leaves something the boss can see and, once its claim lapses, retry.
   */
  unregistered: Doc<'skills'>[];
  /**
   * The most recent authoring attempt's verdict, already checked against the
   * skill it names. Null once that skill has moved past it, which is what keeps
   * it from sitting above a row that says something else.
   */
  authoringFailure: string | null;
  /** The skill the manager's last attempt registered, said once its row is registered. */
  registered?: string | null;
  /** Retries report here too, so the notice is never older than the last try. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Real mode lists the inputs the executor binds for a skill that predates them. */
  surfaceMode?: 'mock' | 'real';
  /** Makes the card the place focus goes when a decided skill leaves the proposed panel. */
  focusRef?: React.Ref<HTMLElement>;
}) {
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const requestRevision = useMutation(api.skills.requestRevision);
  const [retrying, setRetrying] = useState<Id<'skills'> | null>(null);
  // The control that started a run, and the card that stands in for it once a
  // registration moves its row out of this list.
  const [returnTo, setReturnTo] = useState<{
    control: HTMLElement;
    card: HTMLElement | null;
  } | null>(null);
  const now = useNow();
  const describedBy = useId();

  // A retry or a revision authors for minutes, so its verdict is filed as the
  // attempt (said in the card's live region) rather than awaited by a hook.
  async function reauthor(
    skillId: Id<'skills'>,
    name: string,
    revise: boolean,
    origin: HTMLElement,
  ): Promise<void> {
    setRetrying(skillId);
    setReturnTo({ control: origin, card: origin.closest<HTMLElement>('section[tabindex="-1"]') });
    onAuthoringAttempt(null);
    try {
      if (revise) await requestRevision({ skillId });
      const result = await author({ skillId });
      onAuthoringAttempt(
        result.ok
          ? { skillId, name }
          : {
              skillId,
              name,
              reason:
                result.reason ?? (revise ? 'revision did not succeed' : 'retry did not succeed'),
            },
      );
    } catch (err) {
      onAuthoringAttempt({ skillId, name, reason: refusalText(err, AUTHORING_UNFINISHED) });
    } finally {
      setRetrying(null);
    }
  }

  // The button is disabled while its run holds it, so focus comes back to it
  // once it is enabled again, unless the manager has moved on.
  useEffect(() => {
    if (retrying !== null || returnTo === null) return;
    returnFocus(returnTo.control, returnTo.card);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the focus return happens once per settled run
    setReturnTo(null);
  }, [retrying, returnTo]);

  return (
    <Card title={`Skills · ${skills.length} registered`} focusRef={focusRef}>
      <div role="status" aria-live="polite" aria-atomic="true">
        {authoringFailure ? (
          <p className="mb-3 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-xs text-[var(--color-danger)]">
            Authoring did not finish: {authoringFailure}
          </p>
        ) : registered ? (
          <p className="mb-3 text-xs text-[var(--color-ok)]">
            {registered} is registered: it passed the check and is callable.
          </p>
        ) : null}
      </div>
      {loading ? (
        <p className="text-xs text-[var(--color-muted)]">loading skills…</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">none yet</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {skills.map((s) => (
            <li key={s._id} className="flex items-start gap-2">
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  s.sourceType === 'builtin'
                    ? 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]'
                    : 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                }`}
              >
                {s.sourceType === 'builtin' ? 'builtin' : 'authored'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[var(--color-fg)] break-words">{s.name}</div>
                <div className="text-[var(--color-muted)] text-xs break-words">{s.description}</div>
                {s.sourceType === 'agent-authored' ? (
                  <SkillInputs body={s.body} surfaceMode={surfaceMode} />
                ) : null}
              </div>
              {s.sourceType === 'agent-authored' ? (
                <button
                  type="button"
                  onClick={(event) => {
                    // reauthor files every outcome as the attempt and never rejects.
                    void reauthor(s._id, s.name, true, event.currentTarget);
                  }}
                  disabled={retrying === s._id}
                  title={REVISE_HINT}
                  aria-label={`Revise ${s.name}`}
                  aria-describedby={`${describedBy}-revise`}
                  className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-warn)] text-xs disabled:opacity-50 shrink-0"
                >
                  {retrying === s._id ? 'Revising…' : 'Revise'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {skills.some((skill) => skill.sourceType === 'agent-authored') ? (
        <p id={`${describedBy}-revise`} className="mt-2 text-[10px] text-[var(--color-muted)]">
          {REVISE_HINT}
        </p>
      ) : null}

      {unregistered.length > 0 ? (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
          {/* One honest label for every way a skill can stop short: a skipped
              sandbox, a sandbox that said no, and a registration that was
              interrupted. */}
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-warn)] mb-1.5">
            not registered · not callable
          </p>
          <ul className="space-y-3 text-sm">
            {unregistered.map((s) => (
              <li key={s._id}>
                <div className="flex items-start justify-between gap-2">
                  {/* A traceback's caret line has no break opportunity: without
                      min-w-0 the column keeps its full width and pushes Retry
                      past the card's edge. */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--color-fg)] break-words">{s.name}</div>
                    {/* Three different things, and the row used to say the
                        first for two of them: a run working on it now, whose
                        log is the previous attempt's; a run that died holding
                        it, which the lease has since released; and no run at
                        all, where the log is this skill's own verdict. */}
                    <SkillStatusLine
                      skill={s.name}
                      text={
                        holdsLiveAuthoringClaim(s, now)
                          ? 'authoring now · a run holds this skill'
                          : s.authoringRunId
                            ? 'a run stopped without reporting · Retry takes the skill over'
                            : (s.verificationLog ?? s.description)
                      }
                    />
                    <SkillInputs body={s.body || s.refusedBody || ''} />
                    <p
                      id={`${describedBy}-${s._id}`}
                      className="text-[10px] text-[var(--color-muted)]"
                    >
                      {retryVerifiesSavedDraft(s) ? RETRY_CHECKS_HINT : RETRY_AUTHORS_HINT}
                    </p>
                    <RefusedDraftDetails skill={s} />
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      // reauthor files every outcome as the attempt and never rejects.
                      void reauthor(s._id, s.name, false, event.currentTarget);
                    }}
                    disabled={retrying === s._id}
                    title={retryVerifiesSavedDraft(s) ? RETRY_CHECKS_HINT : RETRY_AUTHORS_HINT}
                    aria-label={`Retry ${s.name}`}
                    aria-describedby={`${describedBy}-${s._id}`}
                    className="min-h-11 px-3 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 shrink-0"
                  >
                    {retrying === s._id ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {/* Two backends can run the check, so naming one of them is advice
              half the readers cannot act on. The rule that picks between them
              is what tells a reader which line is theirs. And a retry costs an
              authoring call for some of these rows and none for others, which
              is the difference between waiting on a sandbox and waiting on the
              model, so the text says which is which rather than claiming one
              for all of them. */}
          <p className="text-[10px] text-[var(--color-muted)] mt-2">
            Retry picks a skill up where it stopped. One parked because the check never ran - the
            sandbox was busy, absent, or threw - keeps its body and smoke test and is checked again
            as it stands, with no second authoring call; one the gate or the check itself turned
            down is authored again, with the reason fed back. Either way it has to pass the check
            before it is callable. If the sandbox was skipped, start one first: run pnpm sandbox:up
            for the bundled local sandbox, or set DAYTONA_API_KEY on the deployment to use Daytona
            instead. Only one authoring run holds a skill at a time, so a retry while one is still
            running is refused until that run finishes or its claim lapses.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/** What Revise does, beside the registered list and for its hover. */
const REVISE_HINT =
  'Discard this body and author the skill again, then verify it - open only before its first execution, while the item it was proposed for still waits for it';

/** What Retry does for a row whose draft is kept. */
const RETRY_CHECKS_HINT =
  'Run the body and smoke test this skill already has through the sandbox check - no new authoring call';

/** What Retry does for every other row. */
const RETRY_AUTHORS_HINT = 'Author this skill again, with the reason it stopped, then verify it';

/**
 * What an unregistered skill's row says under its name.
 *
 * A one-line reason stays prose. A sandbox's log keeps its line breaks, in a
 * box bounded in height that scrolls: a traceback collapsed into one run of
 * text cannot be read, and one left unbounded makes the card as tall as the
 * traceback. `break-words` still wraps a caret line, so Retry stays inside.
 */
function SkillStatusLine({ skill, text }: { skill: string; text: string }) {
  if (!text.includes('\n')) {
    return <div className="text-[var(--color-muted)] text-xs break-words">{text}</div>;
  }
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={`Verification log: ${skill}`}
      className="mt-0.5 text-[var(--color-muted)] text-[11px] leading-snug font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
      data-skill-log="multiline"
    >
      {text}
    </div>
  );
}

/**
 * The inputs an authored skill declares, with the ones the system declared
 * for its author marked.
 *
 * The manager approves a skill before its body exists, so this row is the
 * first place the inputs can be shown. An input the author used without
 * declaring is declared for it in real mode; the body marks that line, and
 * this says so beside the name rather than letting it pass as the author's.
 * In real mode the executor also binds the reply surface for a skill that was
 * registered before that input was taught; it is listed last, marked as
 * bound by Day0, so the line shows every input a run is given. Only a
 * registered skill is given the mode: an attempt that never registered runs
 * nothing, and Retry authors it again under the taught lines.
 */
function SkillInputs({ body, surfaceMode }: { body: string; surfaceMode?: 'mock' | 'real' }) {
  const authored = declaredSkillInputs(body) ?? [];
  if (authored.length === 0) return null;
  const bound = new Set(surfaceMode === 'real' ? impliedSkillInputs(body) : []);
  const declared = [...authored, ...bound];
  const added = new Set(systemDeclaredInputs(body));
  const plural = added.size > 1;
  return (
    <div className="mt-1 text-[10px] text-[var(--color-muted)] break-words">
      <span className="uppercase tracking-wider">inputs</span>{' '}
      {declared.map((name, index) => (
        <span key={name}>
          {index > 0 ? ', ' : ''}
          <code className="font-mono whitespace-nowrap">&lt;{name}&gt;</code>
          {added.has(name) ? ' (added by Day0)' : ''}
          {bound.has(name) ? ' (bound by Day0)' : ''}
        </span>
      ))}
      {added.size > 0 ? (
        <span>
          {' '}
          · The author used the input{plural ? 's' : ''} marked &quot;added by Day0&quot; without
          declaring {plural ? 'them' : 'it'}, so Day0 declared {plural ? 'them' : 'it'}: the
          executor reads {plural ? 'them' : 'it'} from the candidate or its runbook at run time.
        </span>
      ) : null}
      {bound.size > 0 ? (
        <span>
          {' '}
          · This skill was registered before Day0 taught the input marked &quot;bound by Day0&quot;:
          the executor binds it from the Reply target, so the reply goes to the chat surface the ask
          came from.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The draft a refusal turned away before any sandbox ran, behind a disclosure
 * under the failed skill. Read-only: the row keeps it so the manager can see
 * what was refused against the reason above it, and Retry hands it back to the
 * author to correct. Nothing here was registered or checked.
 */
export function RefusedDraftDetails({
  skill,
}: {
  skill: Pick<Doc<'skills'>, 'refusedBody' | 'refusedSmokeTest'> & { name?: string };
}) {
  const body = skill.refusedBody?.trim() ?? '';
  const smokeTest = skill.refusedSmokeTest?.trim() ?? '';
  if (!body && !smokeTest) return null;
  const files = [
    { name: 'SKILL.md', content: body },
    { name: 'smoke.py', content: smokeTest },
  ].filter((file) => file.content);
  return (
    <details className="mt-1 text-xs">
      <summary className={DISCLOSURE_SUMMARY}>
        Refused draft · {files.map((file) => file.name).join(' and ')} · not registered
      </summary>
      <div className="mt-1 space-y-1">
        {files.map((file) => (
          <div key={file.name}>
            <div className="font-mono text-[10px] text-[var(--color-muted)]">{file.name}</div>
            <pre
              tabIndex={0}
              role="region"
              aria-label={`Refused ${file.name}${skill.name ? `: ${skill.name}` : ''}`}
              className="text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]"
            >
              {file.content}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
