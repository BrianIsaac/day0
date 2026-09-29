import { workItemGlossary } from '@/work/state-display';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';

/**
 * The states a work item is shown in, in the manager's words, each beside what it means and the
 * stored state the export carries (round two section 5; `agent-work.html`). The words are the
 * chips' own, so the glossary never disagrees with a card.
 */
export function StateGlossary() {
  return (
    <Card title="The states, in the manager's words" meta="the stored state stays in the export">
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        {workItemGlossary().map((line) => (
          <div key={`${line.state}:${line.label.text}`} className="contents">
            <dt className="pt-0.5">
              <Chip tone={line.label.tone}>{line.label.text}</Chip>
            </dt>
            <dd className="text-[var(--color-fg-2)]">
              {line.means}{' '}
              <span className="font-mono text-[13px] text-[var(--color-muted)]">
                ({line.state})
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
