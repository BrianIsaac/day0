'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** The hand-off of a retire from the employee's page to the company home it lands on. */
interface RetiredHandOff {
  /** Say, on the next page to take it, that this employee was retired. */
  readonly announce: (name: string) => void;
  /** The name announced and not yet said, which taking forgets. */
  readonly take: () => string | null;
}

const RetiredContext = createContext<RetiredHandOff | null>(null);

/**
 * Carries a retire's name across the one navigation after it: the employee's page announces it
 * before it sends the manager home, and the home says it once. It lives with the layout, which a
 * client navigation keeps, so nothing is stored in the address or the browser and a reload says
 * nothing.
 */
export function RetiredNoticeProvider({ children }: { children: ReactNode }) {
  const pending = useRef<string | null>(null);
  const announce = useCallback((name: string): void => {
    pending.current = name;
  }, []);
  const take = useCallback((): string | null => {
    const name = pending.current;
    pending.current = null;
    return name;
  }, []);
  const value = useMemo((): RetiredHandOff => ({ announce, take }), [announce, take]);
  return <RetiredContext value={value}>{children}</RetiredContext>;
}

/** What announcing does where no layout carries the hand-off: there is no next page to tell. */
function announceNowhere(): void {}

/**
 * Announce a retire to the page the manager lands on next. The root layout carries the hand-off;
 * a page drawn on its own (a test, a preview) has no next page, so the announcement goes nowhere.
 */
export function useAnnounceRetired(): (name: string) => void {
  return useContext(RetiredContext)?.announce ?? announceNowhere;
}

/**
 * The line the company home draws once after a retire from an employee's page: "<name> is
 * retired.", as a status that takes focus, so the manager who pressed Retire hears where they
 * landed and why the employee is gone. Nothing is drawn on any other visit.
 */
export function RetiredNotice() {
  const handOff = useContext(RetiredContext);
  const [name, setName] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const retired = handOff?.take() ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- taken once, on the page the retire sent the manager to
    if (retired !== null) setName(retired);
  }, [handOff]);
  useEffect(() => {
    if (name !== null) line.current?.focus();
  }, [name]);
  if (name === null) return null;
  return (
    <p
      ref={line}
      role="status"
      tabIndex={-1}
      className="mb-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm text-[var(--color-fg-2)] outline-none"
    >
      {name} is retired.
    </p>
  );
}
