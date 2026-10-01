import { MAX_AUTHORING_ATTEMPTS } from '@/work/skill-library';
import { Card } from '../../../components/Card';

/**
 * How a skill is made, beside the Skills tab's lists: proposed when work needs it, approved by
 * the manager, written and checked in a sandbox, registered only once the check passes, with up
 * to three attempts each; and what the manager's controls on a registered skill reach.
 *
 * @param name - The employee's name.
 */
export function HowSkillsAreMade({ name }: { name: string }) {
  return (
    <Card title="How a skill is made">
      <ol className="grid list-decimal gap-2 pl-5 text-sm text-[var(--color-fg-2)] marker:text-[var(--color-muted)]">
        <li>{name} proposes one when work needs it, naming the item.</li>
        <li>You approve; {name} writes it and checks it with a smoke test in a sandbox.</li>
        <li>
          It registers only once the check passes; a draft that fails stays on this tab with the
          reason, and Retry feeds the reason back, for up to {MAX_AUTHORING_ATTEMPTS} attempts.
        </li>
      </ol>
      <p className="mt-3 text-[13px] text-[var(--color-muted)]">
        One run writes a skill at a time: Retry waits while one is running and opens once it
        finishes or its hold lapses.
      </p>
      <p className="mt-2 text-[13px] text-[var(--color-muted)]">
        A registered skill keeps running while it is revised, and while it is re-checked unless the
        check fails. Retire takes it from {name} alone; when other employees run the same version,
        the same dialog can withdraw it from all of them.
      </p>
    </Card>
  );
}
