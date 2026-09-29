import type { KnowledgeProjection as Projection } from '@/memory/projection';
import { Card } from '../../../components/Card';
import { Disclosure } from '../../../components/Disclosure';

/**
 * "What <name> knows" (decision A2): the readable projection of the employee's charter, people,
 * working agreements, skills, connections and documentation, behind a disclosure. It is made
 * from the rows each time one changes and is for the manager only: the employee never reads it.
 *
 * @param name - The employee's name.
 * @param projection - The projection, or undefined while it loads.
 */
export function KnowledgeProjection({
  name,
  projection,
}: {
  name: string;
  projection: Projection | undefined;
}) {
  return (
    <Card title={`What ${name} knows`} meta="regenerated on change">
      <p className="text-sm leading-relaxed text-[var(--color-fg-2)]">
        A readable projection of {name}&apos;s charter, people, working agreements, skills,
        connections and documentation, capped at 4,000 characters. {name} never reads it; it is for
        you.
      </p>
      {projection === undefined ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">Loading the projection</p>
      ) : (
        <div className="mt-2">
          <Disclosure summary="Read the projection">
            <pre
              tabIndex={0}
              aria-label={`What ${name} knows`}
              className="max-h-96 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[var(--color-fg-2)]"
            >
              {projection.text}
            </pre>
            {projection.cut ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Cut at 4,000 characters, the projection&apos;s bound.
              </p>
            ) : null}
          </Disclosure>
        </div>
      )}
    </Card>
  );
}
