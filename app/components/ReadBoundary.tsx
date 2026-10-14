'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '@/lib/logger';

/** What the boundary keeps: whether a read below it threw, and the read's answer it threw at. */
interface ReadBoundaryState {
  readonly failed: boolean;
  readonly resetKey: unknown;
}

/** What the boundary is given. */
interface ReadBoundaryProps {
  readonly what: string;
  readonly fallback: ReactNode;
  /**
   * The read's answer, where the page holds the read above the boundary: once it changes (the read
   * answers again), the boundary draws what is below it again rather than its fallback for good
   * (W17-R28).
   */
  readonly resetKey?: unknown;
  readonly children: ReactNode;
}

/**
 * A net for one read on a page: a query that throws below it (`useQuery` rethrows what the
 * backend's query threw) draws `fallback` in its place, and the rest of the page stays. For a read
 * whose failure says nothing about the page around it, such as an employee's figures over rows
 * too large for one function's read (C1, 17-FW; W16-R31), which took the whole page down. Given
 * the read's answer as `resetKey`, it tries again once that answer changes.
 *
 * @param what - What the read is, for the log line.
 * @param fallback - Drawn in the read's place once it has thrown.
 * @param resetKey - The read's answer; a new one draws the read's place again.
 */
export class ReadBoundary extends Component<ReadBoundaryProps, ReadBoundaryState> {
  state: ReadBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ReadBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ReadBoundaryProps,
    state: ReadBoundaryState,
  ): Partial<ReadBoundaryState> | null {
    // The read answered again: what is below is drawn again, and throws again if it must.
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { failed: false, resetKey: props.resetKey };
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
