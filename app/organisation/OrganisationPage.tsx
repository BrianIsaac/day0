'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ConvexError } from 'convex/values';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { deploymentZone, formatStamp } from '@/lib/zone';
import Link from 'next/link';
import { Button, buttonClass } from '../components/Button';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Dialog } from '../components/Dialog';
import { Field, INPUT_CLASS } from '../components/Field';
import { StatusRegion } from '../components/StatusRegion';
import { useChange } from '../components/use-change';
import {
  connectionStatusChip,
  kindWords,
  ledgerLineWords,
  modeWords,
  ORGANISATION_REFUSED,
  registeredWords,
  revokeLines,
  ROTATE_NOTE,
  secretWords,
  type ConnectionView,
  type LedgerLine,
} from './organisation-words';

/** The page's width and gutters, as the documentation page sets its own. */
const PAGE = 'mx-auto grid w-full max-w-5xl gap-8 px-4 py-10 sm:px-6';

/** What the organisation page is opened with. */
export interface OrganisationPageProps {
  /**
   * The card an access request's link names (`?card=<surfaceId>`), for recording that employee's
   * own Linear app (AL9); the page reads no card itself (B8).
   */
  readonly cardId?: string;
  /** The zone times are named in; the deployment's when absent. */
  readonly zone?: string;
  /** Follow an installation link in this tab; the browser's own when absent. */
  readonly navigate?: (url: string) => void;
}

/**
 * The organisation page (B8; the access plan, section 4.1): for the deployment's administrators,
 * each system IT connected for every employee, with its mode, what was registered, its status,
 * who registered it and when, and whether a secret is held; a new secret and a revoke, each
 * confirmed first; and the ledger of every change, newest first. Anyone else who opens its
 * address is told in words whose page it is, and no administrator's read is asked for them. An
 * administrator reads no employee's card here: an employee's own Linear app is recorded from the
 * link its access request carries.
 */
export function OrganisationPage({ cardId, zone, navigate }: OrganisationPageProps) {
  const summary = useQuery(api.organisationConnections.summaryForManager, {});
  const administrator = summary?.callerIsAdministrator === true;
  const connections = useQuery(
    api.organisationConnections.listForAdministrator,
    administrator ? {} : 'skip',
  );
  const ledger = useQuery(api.connectionEvents.forAdministrator, administrator ? {} : 'skip');
  const shownZone = zone ?? deploymentZone();

  if (summary === undefined) {
    return (
      <div className={PAGE}>
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Loading the organisation&apos;s connections
        </p>
      </div>
    );
  }
  if (!administrator) {
    return (
      <div className={PAGE}>
        <div className="grid max-w-2xl gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{ORGANISATION_REFUSED.title}</h1>
          {ORGANISATION_REFUSED.lines.map((line) => (
            <p key={line} className="text-[15px] leading-relaxed text-[var(--color-fg-2)]">
              {line}
            </p>
          ))}
          <div>
            <Link href="/" className={buttonClass('secondary')}>
              Back to your employees
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const linearPerEmployee = (connections ?? []).find(
    (connection) =>
      connection.system === 'linear' &&
      connection.mode === 'per-employee' &&
      connection.status === 'active',
  );
  return (
    <div className={PAGE}>
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Organisation</h1>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          The systems IT connected once for every employee. Each employee&apos;s access still needs
          its manager&apos;s approval, on its card.
        </p>
      </div>
      <section aria-labelledby="organisation-connections" className="grid gap-4">
        <h2 id="organisation-connections" className="text-lg font-semibold">
          Connections
        </h2>
        {connections === undefined ? (
          <p role="status" className="text-sm text-[var(--color-muted)]">
            Loading the organisation&apos;s connections
          </p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-2)]">
            No system is connected for the organisation yet. IT connects each one once with{' '}
            <code className="font-mono text-[13px]">./setup.sh access</code>.
          </p>
        ) : (
          connections.map((connection) => (
            <ConnectionCard key={connection._id} connection={connection} zone={shownZone} />
          ))
        )}
      </section>
      {linearPerEmployee !== undefined ? (
        <EmployeeAppSection cardId={cardId} navigate={navigate} />
      ) : null}
      <LedgerSection ledger={ledger} zone={shownZone} />
    </div>
  );
}

/** One labelled line of a connection's facts. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-[var(--color-fg-2)]">{children}</dd>
    </div>
  );
}

/**
 * One connection's card: its facts, why it needs IT or was revoked, and its two controls while it
 * is not revoked: a new secret where one is held, and Revoke.
 */
function ConnectionCard({ connection, zone }: { connection: ConnectionView; zone: string }) {
  const [open, setOpen] = useState<'rotate' | 'revoke' | null>(null);
  const card = useRef<HTMLElement>(null);
  // A revoke takes its control with it: the card takes focus once the dialog has closed, after
  // the dialog hands focus back to a control that is no longer there.
  const focusCardOnClose = useRef(false);
  useEffect(() => {
    if (open !== null || !focusCardOnClose.current) return;
    focusCardOnClose.current = false;
    card.current?.focus();
  }, [open]);
  const chip = connectionStatusChip(connection.status);
  const live = connection.status !== 'revoked';
  return (
    <Card
      focusRef={card}
      title={connection.displayName}
      meta={<Chip tone={chip.tone}>{chip.text}</Chip>}
      tone={connection.status === 'needs-attention' ? 'warn' : undefined}
      data-connection={connection._id}
    >
      <div className="grid gap-4">
        <dl className="grid gap-2.5">
          {connection.statusReason !== undefined ? (
            <Fact label={connection.status === 'revoked' ? 'Reason' : 'Needs IT'}>
              <span
                className={
                  connection.status === 'needs-attention' ? 'text-[var(--color-warn)]' : undefined
                }
              >
                {connection.statusReason}
              </span>
            </Fact>
          ) : null}
          <Fact label="Mode">{modeWords(connection.mode)}</Fact>
          <Fact label="Type">{kindWords(connection)}</Fact>
          <Fact label="Connected by">{registeredWords(connection.registeredBy, zone)}</Fact>
          {connection.lastRotatedAt !== undefined ? (
            <Fact label="New secret">{formatStamp(connection.lastRotatedAt, zone)}</Fact>
          ) : null}
          {connection.revokedAt !== undefined ? (
            <Fact label="Revoked">{formatStamp(connection.revokedAt, zone)}</Fact>
          ) : null}
          <Fact label="Secret">{secretWords(connection, zone)}</Fact>
          <Fact label="Scopes">
            <span className="font-mono text-[13px] break-words">
              {connection.scopes.join(', ') || 'none listed'}
            </span>
          </Fact>
        </dl>
        {live ? (
          <div className="flex flex-wrap gap-3">
            {connection.hasSecret ? (
              <Button size="small" onClick={(): void => setOpen('rotate')}>
                Give it a new secret
              </Button>
            ) : null}
            <Button
              size="small"
              variant="danger"
              className="sm:ml-auto"
              onClick={(): void => setOpen('revoke')}
            >
              Revoke
            </Button>
          </div>
        ) : null}
      </div>
      {open === 'revoke' ? (
        <RevokeDialog
          connection={connection}
          onClose={(): void => setOpen(null)}
          onRevoked={(): void => {
            focusCardOnClose.current = true;
          }}
        />
      ) : null}
      {open === 'rotate' ? (
        <RotateDialog connection={connection} onClose={(): void => setOpen(null)} />
      ) : null}
    </Card>
  );
}

/**
 * The revoke's confirmation (11-AO's `revoke`): what it ends, the reason every card on it will
 * show, and Keep it holding focus; Revoke is held until a reason is given. A refusal is said in
 * the dialog, which stays open.
 */
function RevokeDialog({
  connection,
  onClose,
  onRevoked,
}: {
  connection: ConnectionView;
  onClose: () => void;
  /** The revoke landed; called before the dialog closes. */
  onRevoked: () => void;
}) {
  const revoke = useMutation(api.organisationConnections.revoke);
  // How many cards it ends (11-AC's item 3): until the count answers, the words say every card.
  const counted = useQuery(api.organisationConnections.cardsOn, {
    organisationConnectionId: connection._id as Id<'organisationConnections'>,
  });
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  const [reason, setReason] = useState('');
  const [first, ...rest] = revokeLines(connection, counted ?? undefined);
  const ready = reason.trim() !== '' && !change.busy;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    change.run(
      () =>
        revoke({
          organisationConnectionId: connection._id as Id<'organisationConnections'>,
          reason: reason.trim(),
        }),
      {
        done: `${connection.displayName} is revoked for the organisation.`,
        refused: `${connection.displayName} was not revoked.`,
        after: (): void => {
          onRevoked();
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      role="alertdialog"
      title={`Revoke ${connection.displayName} for the organisation?`}
      description={first}
      onClose={onClose}
      initialFocus={keep}
      busy={change.busy}
    >
      {rest.map((line) => (
        <p key={line} className="text-[15px] leading-relaxed text-[var(--color-fg-2)]">
          {line}
        </p>
      ))}
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="The reason each card will show" hint="Managers read it on their cards.">
          {(control) => (
            <input
              {...control}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              autoComplete="off"
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
            Keep it
          </Button>
          <Button type="submit" variant="danger" size="large" disabled={!ready}>
            {change.busy
              ? `Revoking ${connection.displayName}…`
              : `Revoke ${connection.displayName}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The secret field's label, by what IT registered. */
function secretLabel(kind: ConnectionView['kind']): string {
  switch (kind) {
    case 'slack-configuration':
      return 'New configuration token';
    case 'oauth-app':
    case 'mcp-client':
      return 'New client secret';
    case 'service-account':
      return 'New service account key';
    case 'static-key':
      return 'New key';
    default: {
      const unknown: never = kind;
      throw new Error(`unhandled connection kind ${String(unknown)}`);
    }
  }
}

/**
 * The new secret (11-AO's `rotate`): what it does, the secret and, for Slack's configuration
 * token, its refresh token. The fields are uncontrolled: the values go from the form to the action
 * and never into React state, where a devtools snapshot or an error boundary could keep them.
 */
function RotateDialog({
  connection,
  onClose,
}: {
  connection: ConnectionView;
  onClose: () => void;
}) {
  const rotate = useAction(api.organisationConnections.rotate);
  const change = useChange();
  const formId = useId();
  const refreshable = connection.kind === 'slack-configuration';
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (change.busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const secret = data.get('secret');
    const refreshToken = data.get('refreshToken');
    form.reset();
    if (typeof secret !== 'string' || secret.trim() === '') return;
    change.run(
      () =>
        rotate({
          organisationConnectionId: connection._id as Id<'organisationConnections'>,
          secret,
          ...(typeof refreshToken === 'string' && refreshToken.trim() !== ''
            ? { refreshToken }
            : {}),
        }),
      {
        done: `${connection.displayName} has its new secret.`,
        refused: `${connection.displayName} kept its old secret.`,
        after: onClose,
      },
    );
  };
  return (
    <Dialog
      title={`Give ${connection.displayName} a new secret`}
      description={ROTATE_NOTE}
      onClose={onClose}
      busy={change.busy}
    >
      <form id={formId} className="grid gap-4" onSubmit={submit}>
        <Field label={secretLabel(connection.kind)} hint="Stored encrypted and never shown again.">
          {(control) => (
            <input
              {...control}
              name="secret"
              type="password"
              autoComplete="new-password"
              required
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        {refreshable ? (
          <Field
            label="New configuration refresh token (optional)"
            hint="Slack issues it with the token; Day0 keeps the token current with it."
          >
            {(control) => (
              <input
                {...control}
                name="refreshToken"
                type="password"
                autoComplete="new-password"
                disabled={change.busy}
                className={`${INPUT_CLASS} w-full`}
              />
            )}
          </Field>
        ) : null}
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="large" disabled={change.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={change.busy}>
            {change.busy ? 'Saving the new secret…' : 'Save the new secret'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The browser's own navigation, for an installation link followed in this tab. */
function browserNavigate(url: string): void {
  window.location.assign(url);
}

/**
 * Recording an employee's own Linear app (AL9; per-employee mode, L1): a Linear administrator
 * creates the app from the access request and records its client id and secret here, for the card
 * the request's link names; Day0 then opens Linear to install it. Without such a link there is no
 * card to record it for, and the page says where the link comes from.
 */
function EmployeeAppSection({
  cardId,
  navigate = browserNavigate,
}: {
  cardId?: string;
  navigate?: (url: string) => void;
}) {
  const register = useAction(api.linearIdentityActions.registerEmployeeApp);
  const change = useChange();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (cardId === undefined || change.busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const clientId = data.get('clientId');
    const clientSecret = data.get('clientSecret');
    form.reset();
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return;
    change.run(
      async (): Promise<string> => {
        const outcome = await register({
          surfaceId: cardId as Id<'surfaces'>,
          clientId,
          clientSecret,
        });
        if (!outcome.ok) throw new ConvexError(outcome.message);
        navigate(outcome.authoriseUrl);
        return 'Recorded. Opening Linear to install the app.';
      },
      { done: (words) => words, refused: 'The app was not recorded.' },
    );
  };
  // Without a link naming its card there is nothing to record here: a note, not a section.
  if (cardId === undefined) {
    return (
      <p className="max-w-2xl text-sm text-[var(--color-muted)]">
        An employee&apos;s own Linear app is recorded from the link in its access request. Open that
        link, create the app in Linear as the request says, and record it there.
      </p>
    );
  }
  return (
    <section aria-labelledby="employee-app" className="grid gap-3">
      <h2 id="employee-app" className="text-lg font-semibold">
        An employee&apos;s own Linear app
      </h2>
      <form
        data-employee-app=""
        className="grid max-w-xl gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 sm:p-5"
        onSubmit={submit}
      >
        <p className="text-sm text-[var(--color-fg-2)]">
          Create the app in Linear for the employee the access request names, then record it here.
          Day0 opens Linear for a Linear administrator to install it.
        </p>
        <Field label="Client id">
          {(control) => (
            <input
              {...control}
              name="clientId"
              autoComplete="off"
              required
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <Field
          label="Client secret"
          hint="Stored encrypted for the organisation, never shown again."
        >
          {(control) => (
            <input
              {...control}
              name="clientSecret"
              type="password"
              autoComplete="new-password"
              required
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <StatusRegion outcome={change.outcome} />
        <div>
          <Button type="submit" variant="primary" disabled={change.busy}>
            {change.busy ? 'Recording…' : 'Record the app and install it'}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The organisation's ledger, newest first, each line in the record's words. */
function LedgerSection({ ledger, zone }: { ledger: LedgerLine[] | undefined; zone: string }) {
  return (
    <section aria-labelledby="organisation-ledger" className="grid gap-3">
      <h2 id="organisation-ledger" className="text-lg font-semibold">
        Ledger
      </h2>
      {ledger === undefined ? (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Loading the ledger
        </p>
      ) : ledger.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-2)]">No change to a connection yet.</p>
      ) : (
        <ol
          data-ledger=""
          className="grid divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]"
        >
          {ledger.map((line) => (
            <li
              key={line._id}
              className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4 sm:px-5"
            >
              <time
                dateTime={new Date(line.createdAt).toISOString()}
                className="text-[13px] text-[var(--color-muted)] tabular-nums"
              >
                {formatStamp(line.createdAt, zone)}
              </time>
              <span className="min-w-0 break-words text-[var(--color-fg-2)]">
                {ledgerLineWords(line)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
