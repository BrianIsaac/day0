import type { Doc } from '@convex/_generated/dataModel';
import { declaredSkillInputs, impliedSkillInputs, systemDeclaredInputs } from '@/work/skill-inputs';

/** A code chip: an input, a scope, a skill's own name. */
export const CODE_CHIP =
  'rounded bg-[var(--color-inset)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-fg)] whitespace-nowrap';

/**
 * A skill's plain name: the sentence it was proposed with, without its full stop, or its own
 * name when it carries none.
 *
 * @param skill - The skill row.
 */
export function plainSkillName(skill: Pick<Doc<'skills'>, 'name' | 'description'>): string {
  const description = skill.description.trim().replace(/[.!]$/, '');
  return description === '' ? skill.name : description;
}

/**
 * The scopes a skill needs, as code chips after a word, or nothing when it needs none.
 *
 * @param scopes - The skill's required scopes.
 * @param lead - The word before them.
 */
export function ScopeChips({ scopes, lead }: { scopes?: readonly string[]; lead: string }) {
  if (!scopes || scopes.length === 0) return null;
  return (
    <span>
      {lead}{' '}
      {scopes.map((scope, index) => (
        <span key={scope}>
          {index > 0 ? ' ' : ''}
          <code className={CODE_CHIP}>{scope}</code>
        </span>
      ))}
    </span>
  );
}

/**
 * The inputs an authored skill declares, as code chips, with the ones the system declared for
 * its author marked.
 *
 * The manager approves a skill before its body exists, so this row is the first place the inputs
 * can be shown. An input the author used without declaring is declared for it in real mode; the
 * body marks that line, and this says so beside the name rather than letting it pass as the
 * author's. In real mode the executor also binds the reply surface for a skill that was registered
 * before that input was taught; it is listed last, marked as bound by Day0, so the line shows
 * every input a run is given. Only a registered skill is given the mode: an attempt that never
 * registered runs nothing, and Retry authors it again under the taught lines.
 */
export function SkillInputs({
  body,
  surfaceMode,
}: {
  body: string;
  surfaceMode?: 'mock' | 'real';
}) {
  const authored = declaredSkillInputs(body) ?? [];
  if (authored.length === 0) return null;
  const bound = new Set(surfaceMode === 'real' ? impliedSkillInputs(body) : []);
  const declared = [...authored, ...bound];
  const added = new Set(systemDeclaredInputs(body));
  const plural = added.size > 1;
  return (
    <div className="mt-1 text-xs leading-relaxed text-[var(--color-muted)] break-words">
      <span>inputs</span>{' '}
      {declared.map((name, index) => (
        <span key={name}>
          {index > 0 ? ' ' : ''}
          <code className={CODE_CHIP}>&lt;{name}&gt;</code>
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
 * What an unregistered skill's row says under its name.
 *
 * A one-line reason stays prose. A sandbox's log keeps its line breaks, in a box bounded in
 * height that scrolls: a traceback collapsed into one run of text cannot be read, and one left
 * unbounded makes the card as tall as the traceback. `break-words` still wraps a caret line, so
 * Retry stays inside.
 */
export function SkillStatusLine({ skill, text }: { skill: string; text: string }) {
  if (!text.includes('\n')) {
    return <p className="text-[13px] text-[var(--color-fg-2)] break-words">{text}</p>;
  }
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={`Verification log: ${skill}`}
      className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-snug whitespace-pre-wrap break-words text-[var(--color-fg-2)]"
      data-skill-log="multiline"
    >
      {text}
    </div>
  );
}
