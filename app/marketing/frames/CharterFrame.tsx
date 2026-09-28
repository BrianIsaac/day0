import type { CSSProperties } from 'react';
import { CHARTER, type CharterRule } from './fixtures';
import { Chip, ProductFrame } from './ProductFrame';

/** Step 3: the charter review card, one rule confirmed and one struck by the manager. */
export function CharterFrame() {
  return (
    <ProductFrame caption={`Charter review · version ${CHARTER.version} · awaiting your approval`}>
      <div className="grid gap-2.5 px-4 py-4">
        <p className="text-sm text-[var(--color-muted)]">
          These words will limit the work. Confirm or strike each one.
        </p>
        {CHARTER.rules.map((rule, index) => (
          <RuleRow key={rule.quote} rule={rule} index={index} />
        ))}
      </div>
    </ProductFrame>
  );
}

function RuleRow({ rule, index }: { rule: CharterRule; index: number }) {
  const struck = rule.decision === 'struck';
  return (
    <div
      data-seq=""
      style={{ '--i': index } as CSSProperties}
      className={`grid gap-x-4 gap-y-2 rounded-[10px] border px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] ${
        struck
          ? 'border-[var(--color-border)] bg-[var(--color-card)]'
          : 'border-[var(--color-warn)]/40 bg-[var(--color-bg)]'
      }`}
    >
      <div className="min-w-0">
        <p
          data-seq={struck ? 'strike' : undefined}
          className={
            struck
              ? 'text-[var(--color-muted)] line-through decoration-[var(--color-danger)] decoration-2'
              : 'italic'
          }
        >
          {rule.saidByManager ? `“${rule.quote}”` : rule.quote}
        </p>
        <p className="mt-1.5 text-sm text-zinc-300">
          {rule.kind} ·{' '}
          {struck ? (
            'derived by your employee · struck by you'
          ) : (
            <>
              in the charter as{' '}
              <b className="font-semibold text-[var(--color-fg)]">{rule.clause}</b>
            </>
          )}
        </p>
      </div>
      <div className="sm:justify-self-end">
        <Chip tone={struck ? 'danger' : 'ok'}>{struck ? 'Struck' : 'Confirmed'}</Chip>
      </div>
    </div>
  );
}
