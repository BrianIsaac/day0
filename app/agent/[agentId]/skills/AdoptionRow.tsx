/**
 * Where the proposals would offer a colleague's verified skill for adoption (decision A3), said
 * once for the card as what the product does today: every skill is written and checked for the one employee that
 * proposed it. The adoption the design draws waits on a lookup of the owner's skills by shape and
 * on a re-verification that keeps a registered skill's smoke test (see the wave 6 E handover), so
 * this row names no colleague and offers nothing to press.
 *
 * @param name - The employee the skill would be written for.
 */
export function AdoptionRow({ name }: { name: string }) {
  return (
    <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] px-3 py-2 text-[13px] text-[var(--color-fg-2)]">
      Each skill here is written and checked for {name} alone; your employees do not share skills.
    </p>
  );
}
