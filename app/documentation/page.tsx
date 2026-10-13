import type { Metadata } from 'next';
import { SessionGate, SessionPending } from '../Providers';
import { DocumentationPage } from './DocumentationPage';

/** The page's title in the tab, where it read "Day0" alone (the v0.20.0 walk's finding 8). */
export const metadata: Metadata = { title: 'Documentation · Day0' };

/** Render the owner-level documentation location manager once Convex holds the owner's token. */
export default function Page(): React.ReactNode {
  return (
    <SessionGate fallback={<SessionPending>loading documentation…</SessionPending>}>
      <DocumentationPage />
    </SessionGate>
  );
}
