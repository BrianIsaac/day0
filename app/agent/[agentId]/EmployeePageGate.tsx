'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { log } from '@/lib/logger';
import { EmployeeDeparted } from './EmployeeDeparted';
import { EmployeeLoading } from './EmployeeShell';
import { NoSuchEmployee } from './NoSuchEmployee';

/** What the employee page draws for its reader, as `transferDepartures.employeePage` answers it. */
type EmployeePage = FunctionReturnType<typeof api.transferDepartures.employeePage>;

/**
 * The employee page's first read: whether the employee is the reader's to show, asked before the
 * shell subscribes to the employee. The shell's read refuses another account's employee, and the
 * refusal, though the page draws it right, reached the old manager's console on every load of an
 * employee they handed over and the moment the new manager accepted (the v0.12.0 walk). This read
 * answers where the employee went without a refusal, and stays subscribed, so an acceptance
 * swaps the open page for the departure before the shell's read is ever drawn.
 *
 * A failed read is logged and the shell drawn as before: the shell's own read and the page's net
 * still answer every case, so the page never waits on this one.
 *
 * @param agentId - The employee the route names.
 * @param children - The shell, drawn while the employee is the reader's own or names none.
 */
export function EmployeePageGate({ agentId, children }: { agentId: string; children: ReactNode }) {
  // `useQueries` subscribes by the object's identity, so it is made once per employee.
  const queries = useMemo(
    () => ({ page: { query: api.transferDepartures.employeePage, args: { agentId } } }),
    [agentId],
  );
  const { page }: Record<string, EmployeePage | undefined | Error> = useQueries(queries);
  const failed = page instanceof Error ? page.message : undefined;
  useEffect(() => {
    if (failed !== undefined) {
      log.warn('employee page read failed; the shell answers it', { agentId, reason: failed });
    }
  }, [agentId, failed]);
  if (page === undefined) return <EmployeeLoading />;
  if (page instanceof Error || page.page === 'employee') return <>{children}</>;
  if (page.page === 'departed') return <EmployeeDeparted departure={page.departure} />;
  return <NoSuchEmployee />;
}
