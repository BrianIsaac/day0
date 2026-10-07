'use client';

import { useState, type FormEvent } from 'react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { DOCS_NOTION_LOCATOR, serverKindHelp } from '@/docs/components';
import { feishuLocator, feishuReaderSecret, type FeishuRegion } from '@/docs/feishu-source';
import { REPOSITORY_URL } from '@/setup/quickstart';
import { Button } from '../components/Button';
import { INPUT_CLASS } from '../components/Field';
import { refusalText } from '../components/use-change';

/** The kinds of location the backend reads, as `docSources.link` takes them. */
export type SourceKind = 'folder' | 'git' | 'urls' | 'mcp' | 'feishu';

/** The MCP servers a documentation source can be read from. */
export type ServerKind = 'notion' | 'confluence' | 'drive' | 'generic';

/** The kinds the form offers, in its order, with the name the manager reads. */
const SOURCE_KINDS: ReadonlyArray<readonly [SourceKind, string]> = [
  ['folder', 'Folder of Markdown'],
  ['git', 'Git repository'],
  ['urls', 'List of URLs'],
  ['mcp', 'MCP server'],
  ['feishu', 'Feishu or Lark wiki or folder'],
];

/** The regions a Feishu source can be in, with the name the manager reads. */
const FEISHU_REGION_NAMES: ReadonlyArray<readonly [FeishuRegion, string]> = [
  ['feishu', 'Feishu (open.feishu.cn)'],
  ['lark', 'Lark (open.larksuite.com)'],
];

/** The MCP servers the form offers, with the name the manager reads. */
const SERVER_KINDS: ReadonlyArray<readonly [ServerKind, string]> = [
  ['notion', 'Notion'],
  ['confluence', 'Confluence'],
  ['drive', 'Google Drive'],
  ['generic', 'Generic resources'],
];

/** The label the form starts with, for the documentation folder it starts on. */
const FOLDER_LABEL = 'Team folder';

/** A field's label above it. */
const LABEL = 'text-[13px] font-medium text-[var(--color-fg-2)]';

/** A field's help beneath it. */
const HELP = 'text-[13px] text-[var(--color-muted)]';

/**
 * The location a kind starts from: the documentation folder itself for a folder, nothing for the
 * rest.
 *
 * @param kind - The selected source kind.
 */
export function locatorForSourceKind(kind: SourceKind): string {
  return kind === 'folder' ? '.' : '';
}

/**
 * The link form's text fields once a source has been linked: both empty, so
 * the next source's label and location are typed into a blank field instead
 * of over the last one's. The kind stays as chosen, and the folder default
 * (`.`) is not offered again: that folder has just been linked.
 *
 * Returns:
 *   The label and locator to show.
 */
export function linkFormAfterLink(): { label: string; locator: string } {
  return { label: '', locator: '' };
}

/** The author guide to the page shapes day0 reads, as the repository publishes it. */
export const AUTHOR_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/running/documentation.md`;

/** The guide to the Feishu app IT sets up for a Feishu source, as the repository publishes it. */
export const FEISHU_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/running/reader-feishu.md`;

/**
 * The secret a link sends for a source kind (E-74).
 *
 * An MCP server's connection secret is required, and so is a Feishu app's
 * ID and secret (joined by the form); a git repository or a list of wiki
 * pages may carry the reader's own secret, sent only when one was typed; a
 * folder takes none.
 *
 * @param kind - The selected source kind.
 * @param typed - What the secret field held, or the Feishu app's ID and secret joined.
 */
export function credentialForLink(kind: SourceKind, typed: string): string | undefined {
  if (kind === 'mcp' || kind === 'feishu') return typed;
  return (kind === 'git' || kind === 'urls') && typed !== '' ? typed : undefined;
}

/**
 * The optional reader secret of a private repository or a wiki behind a
 * login: entered here, encrypted when submitted, and never written into the
 * location itself (E-74).
 *
 * @param props - The selected source kind.
 * @returns The field and its help line for a git or URL source, nothing otherwise.
 */
export function ReaderSecretField(props: { kind: SourceKind }): React.ReactNode {
  if (props.kind !== 'git' && props.kind !== 'urls') return null;
  return (
    <div className="grid gap-1.5">
      <label className={LABEL} htmlFor="reader-secret">
        Reader secret (optional)
      </label>
      <input
        id="reader-secret"
        name="credential"
        type="password"
        autoComplete="new-password"
        aria-describedby="reader-secret-help"
        placeholder={props.kind === 'git' ? 'Access token, or user:token' : 'Access token'}
        className={`${INPUT_CLASS} w-full`}
      />
      <p id="reader-secret-help" className={HELP}>
        {props.kind === 'git'
          ? 'For a private repository. It is encrypted when submitted, sent only to the repository host, and never displayed again.'
          : 'For pages behind a login, all on one https site. It is encrypted when submitted, sent only to that site, and never displayed again.'}
      </p>
    </div>
  );
}

/**
 * A Feishu source's region and the app it reads as: the app's ID, and its
 * secret, entered here and encrypted when submitted. Uncontrolled, so the
 * form's reset clears the secret the moment it is submitted.
 *
 * @returns The region choice and the two app fields.
 */
export function FeishuAppFields(): React.ReactNode {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label htmlFor="feishu-region" className={LABEL}>
          Region
        </label>
        <select
          id="feishu-region"
          name="region"
          defaultValue="feishu"
          className={`${INPUT_CLASS} w-full`}
        >
          {FEISHU_REGION_NAMES.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor="feishu-app-id" className={LABEL}>
            App ID
          </label>
          <input
            id="feishu-app-id"
            name="appId"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="cli_..."
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="feishu-app-secret" className={LABEL}>
            App secret
          </label>
          <input
            id="feishu-app-secret"
            name="appSecret"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="feishu-app-help"
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
      </div>
      <p id="feishu-app-help" className={HELP}>
        Choose Lark if your company&apos;s Feishu address ends in larksuite.com; a pasted Lark or
        Feishu link names its own region. The secret is encrypted when submitted, sent only to
        Feishu or Lark, and never displayed again.
      </p>
    </div>
  );
}

/**
 * Say what this source kind will actually reach, and what has to be running.
 *
 * Four of the five kinds are read by the backend itself and depend on nothing
 * else; the fifth reaches an MCP server, and only one of those servers is one
 * day0 bundles a component for. Saying so in the form is what keeps a reader
 * from assuming every documentation source needs a container started. A
 * Feishu source also says where IT's guide to its app is.
 *
 * @param props - The selected source kind, and the MCP server kind when it applies.
 * @returns The help line under the form fields.
 */
export function SourceKindHelp(props: {
  kind: SourceKind;
  serverKind: ServerKind;
}): React.ReactNode {
  if (props.kind === 'feishu') {
    return (
      <p className={HELP}>
        The backend reads this wiki space or folder through Feishu&apos;s or Lark&apos;s open
        platform, as the app IT created. No day0 component has to be running.{' '}
        <a href={FEISHU_GUIDE_URL} target="_blank" rel="noreferrer">
          How IT sets up the app
        </a>
        .
      </p>
    );
  }
  return (
    <p className={HELP}>
      {props.kind === 'mcp'
        ? `${serverKindHelp(props.serverKind)} The secret is encrypted when submitted and is never displayed again.`
        : 'The backend reads this location itself. No day0 component has to be running.'}
    </p>
  );
}

/**
 * The form that links one documentation location for all the owner's employees, in the kinds
 * the backend reads (`docSources.link`): a folder of Markdown, a git repository, a list of URLs,
 * an MCP server (Notion, Confluence, Google Drive or generic resources), or a Feishu or Lark
 * wiki space or folder. A secret field is write-only: the form is reset the moment it is
 * submitted. A refusal is said under the form.
 */
export function LinkSourceForm(): React.ReactNode {
  const link = useAction(api.docSources.link);
  const [kind, setKind] = useState<SourceKind>('folder');
  const [label, setLabel] = useState(FOLDER_LABEL);
  const [locator, setLocator] = useState('.');
  const [serverKind, setServerKind] = useState<ServerKind>('notion');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Link the submitted source and clear its write-only credential field. */
  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const region: FeishuRegion = values.get('region') === 'lark' ? 'lark' : 'feishu';
    const credential =
      kind === 'feishu'
        ? feishuReaderSecret(
            String(values.get('appId') ?? ''),
            String(values.get('appSecret') ?? ''),
          )
        : String(values.get('credential') || '');
    form.reset();
    setBusy(true);
    setError(null);
    try {
      await link({
        label,
        kind,
        locator: kind === 'feishu' ? feishuLocator(region, locator) : locator,
        serverKind: kind === 'mcp' ? serverKind : undefined,
        credential: credentialForLink(kind, credential),
      });
      const cleared = linkFormAfterLink();
      setLabel(cleared.label);
      setLocator(cleared.locator);
    } catch (failure) {
      setError(refusalText(failure, 'The location was not linked.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <p className={HELP}>
        Write pages in the shapes{' '}
        <a href={AUTHOR_GUIDE_URL} target="_blank" rel="noreferrer">
          the documentation author guide
        </a>{' '}
        describes, so day0 finds each system, address, credential and intake queue on them.
      </p>
      {/* The handler says its own refusal under the form; nothing is left to reject. */}
      <form onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor="source-kind" className={LABEL}>
            Kind of location
          </label>
          <select
            id="source-kind"
            value={kind}
            onChange={(event) => {
              const nextKind = event.target.value as SourceKind;
              setKind(nextKind);
              setLocator(locatorForSourceKind(nextKind));
              // The folder's default label names a folder; a label the manager typed stays.
              if (label === FOLDER_LABEL && nextKind !== 'folder') setLabel('');
            }}
            className={`${INPUT_CLASS} w-full`}
          >
            {SOURCE_KINDS.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="source-label" className={LABEL}>
            Location label
          </label>
          <input
            id="source-label"
            value={label}
            placeholder="Location label"
            onChange={(event) => setLabel(event.target.value)}
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="source-locator" className={LABEL}>
            Where it is
          </label>
          <textarea
            id="source-locator"
            value={locator}
            onChange={(event) => setLocator(event.target.value)}
            placeholder={
              kind === 'folder'
                ? 'Relative to /docs, for example .'
                : kind === 'mcp' && serverKind === 'notion'
                  ? DOCS_NOTION_LOCATOR
                  : kind === 'feishu'
                    ? "Wiki space ID, or a Drive folder's address"
                    : 'Location URL, or one URL per line'
            }
            className={`${INPUT_CLASS} min-h-20 w-full`}
          />
        </div>
        {kind === 'mcp' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor="source-server" className={LABEL}>
                Server
              </label>
              <select
                id="source-server"
                value={serverKind}
                onChange={(event) => setServerKind(event.target.value as ServerKind)}
                className={`${INPUT_CLASS} w-full`}
              >
                {SERVER_KINDS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="source-secret" className={LABEL}>
                Connection secret
              </label>
              <input
                id="source-secret"
                name="credential"
                type="password"
                autoComplete="new-password"
                required
                className={`${INPUT_CLASS} w-full`}
              />
            </div>
          </div>
        ) : null}
        {kind === 'feishu' ? <FeishuAppFields /> : null}
        <ReaderSecretField kind={kind} />
        <SourceKindHelp kind={kind} serverKind={serverKind} />
        <p role="alert" className="text-[13px] text-[var(--color-danger)]">
          {error ?? ''}
        </p>
        <Button type="submit" variant="primary" disabled={busy} className="justify-self-start">
          {busy ? 'Linking…' : 'Link location'}
        </Button>
      </form>
    </div>
  );
}
