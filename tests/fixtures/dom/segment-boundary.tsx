import { Component, type ComponentType, type ReactNode } from 'react';

/** What Next hands a route segment's `error.js`. */
export interface SegmentErrorProps {
  readonly error: Error & { digest?: string };
  readonly unstable_retry: () => void;
}

interface Caught {
  readonly error: Error | null;
}

/**
 * A route segment's error boundary as Next draws one around the segment: the segment's children
 * until one throws in render, then its `error.js` with the error and a retry that renders the
 * children again.
 */
export class SegmentBoundary extends Component<
  { readonly fallback: ComponentType<SegmentErrorProps>; readonly children: ReactNode },
  Caught
> {
  state: Caught = { error: null };

  static getDerivedStateFromError(error: unknown): Caught {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render(): ReactNode {
    const Fallback = this.props.fallback;
    return this.state.error === null ? (
      this.props.children
    ) : (
      <Fallback error={this.state.error} unstable_retry={(): void => this.setState({ error: null })} />
    );
  }
}
