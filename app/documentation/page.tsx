import { SessionGate } from '../Providers';
import { DocumentationPage } from './DocumentationPage';

/** Render the owner-level documentation location manager once Convex holds the owner's token. */
export default function Page(): React.ReactNode {
  return (
    <SessionGate fallback={null}>
      <DocumentationPage />
    </SessionGate>
  );
}
