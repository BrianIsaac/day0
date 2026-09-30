import { SessionGate, SessionPending } from '../Providers';
import { DocumentationPage } from './DocumentationPage';

/** Render the owner-level documentation location manager once Convex holds the owner's token. */
export default function Page(): React.ReactNode {
  return (
    <SessionGate fallback={<SessionPending>loading documentation…</SessionPending>}>
      <DocumentationPage />
    </SessionGate>
  );
}
