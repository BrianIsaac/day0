'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '@/lib/logger';

/** What the boundary keeps: whether a read below it threw. */
interface ReadBoundaryState {
  readonly failed: boolean;
}

/**
 * A net for one read on a page: a query that throws below it (`useQuery` rethrows what the
 * backend's query threw) draws `fallback` in its place, and the rest of the page stays. For a read
 * whose failure says nothing about the page around it, such as an employee's figures over rows
 * too large for one function's read (C1, 17-FW; W16-R31), which took the whole page down.
 *
 * @param what - What the read is, for the log line.
 * @param fallback - Drawn in the read's place once it has thrown.
 */
export class ReadBoundary extends Component<
  { readonly what: string; readonly fallback: ReactNode; readonly children: ReactNode },
  ReadBoundaryState
> {
  state: ReadBoundaryState = { failed: false };

  static getDerivedStateFromError(): ReadBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.warn('a read on the page failed; the page drew it as unread', {
      what: this.props.what,
      reason: error.message,
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
    });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
