'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { MOCK_OFFICE_DOCUMENTATION } from '@/surfaces/mock-office';
import { LinkSourceForm } from './LinkSourceForm';
import { SourceTable } from './SourceTable';

/**
 * Owner-level documentation: the sources linked once for all the owner's employees, as the
 * table each employee's Documentation tab also draws, and the form that links another. The
 * hosted office links nothing, and says what it reads in the one sentence the home's card and
 * the take-on dialog say (RM26 (a)).
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
          {/* Neither office's words until the mode answers (W16-R35): the page says Loading below. */}
          {config === undefined ? null : (
            <p className="text-sm text-[var(--color-muted)] mt-2">
              {config.mode === 'mock'
                ? 'What your employees read for documentation.'
                : 'Link read-only locations. Day0 learns systems and action shapes from their pages.'}
            </p>
          )}
        </div>
        {/* The hosted office says what it is in the one sentence below, not in the mode's name. */}
        {config === undefined || config.mode === 'mock' || !config.label ? null : (
          <span className="text-xs border border-[var(--color-border)] rounded-full px-3 py-1">
            {config.label}
          </span>
        )}
      </div>

      {config === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading</p>
      ) : !isReal ? (
        <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
          <h2 className="font-medium">The hosted office&apos;s documentation</h2>
          <p className="text-sm text-[var(--color-muted)] mt-2">{MOCK_OFFICE_DOCUMENTATION}</p>
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
