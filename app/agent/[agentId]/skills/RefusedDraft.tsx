import type { Doc } from '@convex/_generated/dataModel';
import { Disclosure } from '../../../components/Disclosure';
import { refusedLineOf, type RefusedLine } from './refused-line';

// Unwrapped, with its own scroll: a caret under a column only points at it on an unbroken line.
const DRAFT_CLASS =
  'max-h-64 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-relaxed whitespace-pre text-[var(--color-fg-2)]';

/**
 * One file of a refused draft, with the line the check refused marked and a caret under its
 * column when the check named one.
 */
function DraftFile({
  file,
  content,
  skill,
  marked,
}: {
  file: string;
  content: string;
  skill?: string;
  marked?: RefusedLine;
}) {
  const lines = content.split('\n');
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs text-[var(--color-muted)]">{file}</p>
      <pre
        tabIndex={0}
        role="region"
        aria-label={`Refused ${file}${skill ? `: ${skill}` : ''}`}
        className={`mt-1 ${DRAFT_CLASS}`}
      >
        {marked === undefined ? (
          content
        ) : (
          // As wide as the longest line, so the mark runs under all of it when scrolled.
          <span className="inline-block min-w-full">
            {lines.map((line, index) =>
              index + 1 === marked.line ? (
                <span key={index} className="block">
                  <mark className="block bg-[var(--color-warn)]/15 text-[var(--color-fg)]">
                    {line || ' '}
                  </mark>
                  <span className="block text-[var(--color-warn)]">
                    {marked.column !== undefined ? `${' '.repeat(marked.column - 1)}^ ` : '^ '}
                    the check refused line {marked.line}
                    {marked.column !== undefined ? `, column ${marked.column}` : ''}
                  </span>
                </span>
              ) : (
                <span key={index} className="block">
                  {line || ' '}
                </span>
              ),
            )}
          </span>
        )}
      </pre>
    </div>
  );
}

/**
 * The draft a refusal turned away, behind a disclosure under the skill that failed its check:
 * SKILL.md and the smoke test as the row keeps them, the smoke test's refused line marked when the
 * reason names it. Read-only: the manager reads what was refused against the reason, and Retry
 * hands it back to be corrected. Nothing here was registered.
 *
 * @param skill - The row's refused draft and the reason it keeps.
 */
export function RefusedDraft({
  skill,
}: {
  skill: Pick<Doc<'skills'>, 'refusedBody' | 'refusedSmokeTest' | 'verificationLog'> & {
    name?: string;
  };
}) {
  const body = skill.refusedBody?.trim() ?? '';
  // Only the end is trimmed: the check counts lines from the smoke test's first line.
  const smokeTest = skill.refusedSmokeTest?.replace(/\s+$/, '') ?? '';
  if (!body && !smokeTest) return null;
  const marked =
    smokeTest && skill.verificationLog
      ? refusedLineOf(skill.verificationLog, smokeTest)
      : undefined;
  const files = [body ? 'SKILL.md' : '', smokeTest ? 'smoke.py' : ''].filter(Boolean);
  const summary =
    marked !== undefined
      ? `The refused draft, with line ${marked.line} of smoke.py marked`
      : `The refused draft: ${files.join(' and ')}`;
  return (
    <Disclosure summary={`${summary} · not registered`}>
      <div className="grid grid-cols-1 gap-2">
        {body ? <DraftFile file="SKILL.md" content={body} skill={skill.name} /> : null}
        {smokeTest ? (
          <DraftFile file="smoke.py" content={smokeTest} skill={skill.name} marked={marked} />
        ) : null}
      </div>
    </Disclosure>
  );
}
