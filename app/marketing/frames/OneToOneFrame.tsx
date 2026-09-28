import type { CSSProperties } from 'react';
import { ONE_TO_ONE } from './fixtures';
import { ProductFrame } from './ProductFrame';

/** Step 2: the first question of the Day-1 one-to-one and the manager's answer. */
export function OneToOneFrame() {
  return (
    <ProductFrame caption={`Day-1 one-to-one · question 1 of ${ONE_TO_ONE.topics}`}>
      <div className="grid gap-2.5 px-4 py-4">
        <div aria-hidden="true" className="mb-1 grid grid-cols-7 gap-1">
          {Array.from({ length: ONE_TO_ONE.topics }, (_, topic) => (
            <span
              key={topic}
              className={`h-1 rounded-full ${topic === 0 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}
            />
          ))}
        </div>
        <p
          data-seq=""
          style={{ '--i': 0 } as CSSProperties}
          className="max-w-[92%] justify-self-start rounded-xl rounded-bl-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-sm leading-relaxed"
        >
          <span className="mb-1 block text-xs font-semibold text-[var(--color-muted)]">
            Your employee
          </span>
          {ONE_TO_ONE.question}
        </p>
        <p
          data-seq=""
          style={{ '--i': 3 } as CSSProperties}
          className="max-w-[92%] justify-self-end rounded-xl rounded-br-sm border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2.5 text-sm leading-relaxed"
        >
          <span className="mb-1 block text-xs font-semibold text-[var(--color-muted)]">You</span>
          {ONE_TO_ONE.answer}
        </p>
      </div>
    </ProductFrame>
  );
}
