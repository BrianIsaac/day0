'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { LinkSourceForm } from './LinkSourceForm';
import { SourceTable } from './SourceTable';

/**
 * Owner-level documentation: the sources linked once for all the owner's employees, as the
 * table each employee's Documentation tab also draws, and the form that links another. The
 * hosted office links nothing; it reads its own disclosed pages.
 */
export function DocumentationPage(): React.ReactNode {
  const config = useQuery(api.config.surfaceMode);
  const sources = useQuery(api.docSources.listMine);
  const isReal = config?.mode === 'real';
  return (
    <div className="max-w-5xl mx-auto w-full px-6 py-10">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Documentation</h1>
          <p className="text-sm text-[var(--color-muted)] mt-2">
            Link read-only locations. Day0 learns systems and action shapes from their pages.
          </p>
        </div>
        <span className="text-xs border border-[var(--color-border)] rounded-full px-3 py-1">
          {config?.label || 'loading'}
        </span>
      </div>

      {!isReal ? (
        <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
          <h2 className="font-medium">Demo docs (seeded)</h2>
          <p className="text-sm text-[var(--color-muted)] mt-2">
            Linking is a local-run feature. The hosted mock uses its disclosed synthetic pages.
          </p>
        </section>
      ) : (
        <div className="grid gap-8">
          {sources === undefined ? (
            <p className="text-sm text-[var(--color-muted)]">Loading the linked locations</p>
          ) : (
            <SourceTable sources={sources} />
          )}
          <section
            aria-labelledby="link-location"
            className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5"
          >
            <h2 id="link-location" className="mb-3 font-semibold">
              Link a documentation location
            </h2>
            <LinkSourceForm />
          </section>
        </div>
      )}
    </div>
  );
}
