'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

type SourceKind = 'folder' | 'git' | 'urls' | 'mcp';

/** Owner-level documentation source management. */
export function DocumentationPage(): React.ReactNode {
  const config = useQuery(api.config.surfaceMode);
  const sources = useQuery(api.docSources.listMine);
  const link = useMutation(api.docSources.link);
  const unlink = useMutation(api.docSources.unlink);
  const resync = useMutation(api.docSources.resync);
  const [kind, setKind] = useState<SourceKind>('folder');
  const [label, setLabel] = useState('Team folder');
  const [locator, setLocator] = useState('.');
  const [serverKind, setServerKind] = useState<'notion' | 'confluence' | 'drive' | 'generic'>(
    'notion',
  );
  const [credentialRef, setCredentialRef] = useState('NOTION_TOKEN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Link the submitted source without accepting a credential value. */
  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await link({
        label,
        kind,
        locator,
        serverKind: kind === 'mcp' ? serverKind : undefined,
        credentialRef: kind === 'mcp' ? credentialRef : undefined,
      });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isReal = config?.mode === 'real';
  return (
    <main className="max-w-5xl mx-auto w-full px-6 py-10">
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
        <>
          <section className="space-y-3 mb-8">
            {(sources || []).map((source) => (
              <article
                key={source._id}
                className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 flex items-center justify-between gap-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">{source.label}</h2>
                    <span className="text-[10px] uppercase text-[var(--color-accent)]">
                      {source.kind}
                    </span>
                    <span className="text-[10px] rounded px-2 py-0.5 bg-[var(--color-bg)]">
                      {source.status}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-muted)] mt-1 break-all">
                    {source.locator}
                  </p>
                  <p className="text-xs text-[var(--color-muted)] mt-1">
                    {source.pageCount} pages{source.lastError ? ` - ${source.lastError}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void resync({ sourceId: source._id })}
                    className="text-xs border border-[var(--color-border)] rounded px-3 py-1.5"
                  >
                    Re-sync
                  </button>
                  <button
                    onClick={() => void unlink({ sourceId: source._id })}
                    className="text-xs border border-[var(--color-danger)]/40 text-[var(--color-danger)] rounded px-3 py-1.5"
                  >
                    Unlink
                  </button>
                </div>
              </article>
            ))}
            {sources?.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">No locations linked yet.</p>
            ) : null}
          </section>

          <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
            <h2 className="font-semibold mb-4">Link a documentation location</h2>
            <form onSubmit={onSubmit} className="grid gap-3">
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as SourceKind)}
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              >
                <option value="folder">Folder of Markdown</option>
                <option value="git">Git repository</option>
                <option value="urls">List of URLs</option>
                <option value="mcp">MCP server</option>
              </select>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Location label"
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              />
              <textarea
                value={locator}
                onChange={(event) => setLocator(event.target.value)}
                placeholder={
                  kind === 'folder'
                    ? 'Relative to /docs, for example .'
                    : 'Location URL, or one URL per line'
                }
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded min-h-20"
              />
              {kind === 'mcp' ? (
                <div className="grid sm:grid-cols-2 gap-3">
                  <select
                    value={serverKind}
                    onChange={(event) => setServerKind(event.target.value as typeof serverKind)}
                    className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                  >
                    <option value="notion">Notion</option>
                    <option value="confluence">Confluence</option>
                    <option value="drive">Google Drive</option>
                    <option value="generic">Generic resources</option>
                  </select>
                  <input
                    value={credentialRef}
                    onChange={(event) => setCredentialRef(event.target.value)}
                    placeholder="Token environment variable name"
                    className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                  />
                </div>
              ) : null}
              {kind === 'mcp' ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Set the value in .env.local, run pnpm sync:env, then re-sync. Only the variable
                  name is stored.
                </p>
              ) : null}
              {error ? <p className="text-xs text-[var(--color-danger)]">{error}</p> : null}
              <button
                disabled={busy}
                className="justify-self-start px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50"
              >
                {busy ? 'Linking...' : 'Link location'}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
