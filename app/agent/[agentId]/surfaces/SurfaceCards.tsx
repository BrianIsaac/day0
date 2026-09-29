'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { makeFunctionReference } from 'convex/server';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { CredentialOwnerSummary } from '@/surfaces/credential-presentation';
import { awaitsManagerProposal, charterNamesWorkSystems } from '@/surfaces/charter-cards';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { StatusRegion } from '../../../components/StatusRegion';
import { refusalText, useChange } from '../../../components/use-change';
import { ENVIRONMENT_PANEL_ID } from '../environment-hash';
import { useNow } from '../time';
import {
  SurfaceCard,
  type CredentialStatus,
  type ListedSurface,
  type Operation,
  type SurfaceCardActions,
  type SurfaceCardContext,
} from './SurfaceCard';
import { probeOutcomeText, UnnamedSystemsRow } from './SurfaceRows';

/** What the tab says while the surfaces are loading. */
export const LOADING_SURFACES = 'Loading discovered systems, connection status and evidence…';

/** What the tab says before orientation has discovered anything. */
export const EMPTY_SURFACES =
  'No systems have been discovered yet. After charter approval, orientation maps systems from the linked documentation and shows their connection status here.';

/** How a system is reached, as the aside says it beside the cards (round two section 3.9). */
export const HOW_A_SYSTEM_IS_REACHED =
  'Over MCP when the system offers a server; over a documented API when it does not; in a browser as the last rung. The rung decides the blast radius shown on each card, never the words of the ask.';

const credentialSummariesQuery = makeFunctionReference<
  'query',
  Record<string, never>,
  CredentialStatus[]
>('credentials:summaryForOwner');

/** Every source id the cards name, so their labels are read in one query. */
function citedSourceIds(
  surfaces: readonly ListedSurface[],
  credentials: readonly CredentialOwnerSummary[],
): Id<'docSources'>[] {
  const ids = surfaces.flatMap((surface): string[] => {
    const scope = surface.intakeScope;
    return [
      ...(surface.whereFound as Array<{ sourceId?: string }>).map((item) => item.sourceId),
      ...(surface.discoveryEvidence ?? []).map((item) => item.sourceId),
      ...[scope?.team, scope?.project, ...(scope?.projects ?? []), ...(scope?.channels ?? [])].map(
        (value) => value?.sourceId,
      ),
    ].filter((id): id is string => typeof id === 'string');
  });
  const credentialIds = credentials.flatMap((summary): string[] =>
    typeof summary.source === 'object' ? [summary.source.sourceId] : [],
  );
  return [...new Set([...ids, ...credentialIds])] as Id<'docSources'>[];
}

/**
 * The real-mode Surfaces tab: every discovered system's card in the documented order the server
 * gives (D D4), the systems waiting on orientation or on the manager's Propose, and how a system
 * is reached, with the tab's other cards under the systems. One change runs per card, each card
 * keeping its own refusal beside its control; what a change came to is said once for the tab.
 *
 * @param agentId - The employee.
 * @param arriving - Whether the page's cards are still arriving (`Columns`).
 * @param children - The tab's other cards, under the systems.
 */
export function SurfaceCards({
  agentId,
  arriving = false,
  children,
}: {
  agentId: Id<'agents'>;
  arriving?: boolean;
  children?: ReactNode;
}) {
  const surfaces = useQuery(api.surfaces.listForAgent, { agentId });
  const charter = useQuery(api.charters.latest, { agentId });
  const credentialRows = useQuery(credentialSummariesQuery, {});
  const sourceIds = useMemo(
    () => citedSourceIds(surfaces ?? [], credentialRows ?? []),
    [credentialRows, surfaces],
  );
  const sources = useQuery(api.docSources.byIds, { sourceIds });
  const installRedirectConfigured = useQuery(api.surfaces.installRedirectConfigured, {});
  const componentStatus = useQuery(api.config.components, {});
  const now = useNow();
  const approve = useMutation(api.surfaces.approve);
  const reject = useMutation(api.surfaces.reject);
  const setAccessDays = useMutation(api.surfaces.setAccessDays);
  const approveTools = useMutation(api.surfaces.approveTools);
  const requestProposal = useMutation(api.surfaces.requestProposal);
  const reorient = useAction(api.surfaces.reorient);
  const probe = useAction(api.surfaceActions.probe);
  const landCredential = useAction(api.surfaceActions.landCredential);
  const provisionApp = useAction(api.slackProvisionActions.provisionApp);
  // One change per card at a time, and each card's own: a card's refusal or pending state
  // outlives a change made on another card meanwhile.
  const [operations, setOperations] = useState<Readonly<Record<string, Operation>>>({});
  // Where focus goes when the control that made a change leaves with it (the Approve buttons
  // become the card's verdict): the card, set per change.
  const cardFocus = useRef<HTMLElement | null>(null);
  const change = useChange(cardFocus);
  const [reorienting, setReorienting] = useState(false);
  const [reorientError, setReorientError] = useState<string | null>(null);

  const context = useMemo(
    (): SurfaceCardContext => ({
      now,
      sourceLabels: new Map((sources ?? []).map((source) => [String(source._id), source.label])),
      credentials: new Map(
        (credentialRows ?? []).map((summary): [string, CredentialStatus] => [
          String(summary._id),
          summary,
        ]),
      ),
      installRedirectConfigured: installRedirectConfigured === true,
      browserPresent: componentStatus?.browser,
    }),
    [componentStatus, credentialRows, installRedirectConfigured, now, sources],
  );

  /** Set one card's operation, or clear it with `undefined`. */
  function putOperation(surfaceId: string, next: Operation | undefined): void {
    setOperations((current) => {
      const rest = Object.fromEntries(
        Object.entries(current).filter(([id]): boolean => id !== surfaceId),
      );
      return next ? { ...rest, [surfaceId]: next } : rest;
    });
  }

  /**
   * One change to one card: the card shows it in flight and keeps its refusal beside the
   * control, and the tab's live region says what it came to.
   */
  function operate<Result>(
    kind: Operation['kind'],
    surface: { readonly _id: Id<'surfaces'>; readonly slug: string },
    call: () => Promise<Result>,
    words: { done: string | ((result: Result) => string); refused: string },
  ): void {
    putOperation(surface._id, { kind, surfaceId: surface._id });
    // A system waiting on a proposal has no card yet: the systems themselves stand in for it.
    cardFocus.current =
      document.getElementById(`surface-${surface.slug}`) ??
      document.getElementById(ENVIRONMENT_PANEL_ID);
    change.run(
      async (): Promise<Result> => {
        try {
          return await call();
        } catch (failure) {
          putOperation(surface._id, {
            kind,
            surfaceId: surface._id,
            error: refusalText(failure, words.refused),
          });
          throw failure;
        }
      },
      { ...words, after: () => putOperation(surface._id, undefined) },
    );
  }

  function onReorient(): void {
    setReorientError(null);
    setReorienting(true);
    change.run(
      async (): Promise<void> => {
        try {
          await reorient({ agentId });
        } catch (failure) {
          setReorientError(refusalText(failure, 'Orientation did not run again.'));
          throw failure;
        } finally {
          setReorienting(false);
        }
      },
      {
        done: 'Orientation is running again for the declared systems; their cards update here.',
        refused: 'Orientation did not run again.',
      },
    );
  }

  /** The controls of one card, each bound to that card's own change. */
  function actionsFor(surface: ListedSurface): SurfaceCardActions {
    return {
      approve: () =>
        operate('approve', surface, () => approve({ surfaceId: surface._id }), {
          done: `Approved ${surface.displayName}: the probe runs now.`,
          refused: 'The card was not approved.',
        }),
      reject: () =>
        operate(
          'reject',
          surface,
          () => reject({ surfaceId: surface._id, reason: 'Rejected by the operator.' }),
          {
            done: `Rejected ${surface.displayName}: it goes back to declared.`,
            refused: 'The card was not rejected.',
          },
        ),
      probe: () =>
        operate('probe', surface, () => probe({ surfaceId: surface._id }), {
          done: (outcome) => probeOutcomeText(surface.displayName, outcome),
          refused: 'The probe did not run.',
        }),
      land: (label, plaintext) =>
        operate(
          'landing',
          surface,
          () => landCredential({ surfaceId: surface._id, label, plaintext }),
          {
            done: `The credential for ${surface.displayName} is stored; Day0 checks the connection now.`,
            refused: 'The credential was not stored.',
          },
        ),
      provision: (configurationToken) =>
        operate(
          'provision',
          surface,
          () => provisionApp({ surfaceId: surface._id, configurationToken }),
          {
            done: `The app for ${surface.displayName} is registered; install it from the link on the card.`,
            refused: 'The app was not registered.',
          },
        ),
      setDays: (days) => setAccessDays({ surfaceId: surface._id, days }),
      approveTools: (tools) => approveTools({ surfaceId: surface._id, tools }),
    };
  }

  const loaded = surfaces !== undefined && credentialRows !== undefined && charter !== undefined;
  // The server orients only what the approved charter names; the list follows the same rule, so
  // what waits for the manager's Propose is listed beside the cards rather than shown as a card
  // that will never be filed.
  const charterNamesSystems =
    charter?.approved === true &&
    charterNamesWorkSystems(
      (charter.body as { namedSystems?: Array<{ class: string }> } | null)?.namedSystems,
    );
  const listed = surfaces ?? [];
  const awaitingProposal = listed.filter((surface) =>
    awaitsManagerProposal(surface, charterNamesSystems),
  );
  const shown = listed.filter((surface) => !awaitsManagerProposal(surface, charterNamesSystems));
  const cards = shown.filter((surface) => surface.verdict !== 'absent');
  const notFound = shown.filter((surface) => surface.verdict === 'absent');
  const declared = cards.filter((surface) => surface.verdict === 'declared');
  const proposeOperation = Object.values(operations).find((entry) => entry.kind === 'propose');

  const aside = (
    <>
      <Card title="How a system is reached">
        <p className="text-sm text-[var(--color-fg-2)]">{HOW_A_SYSTEM_IS_REACHED}</p>
      </Card>
      {notFound.length > 0 ? (
        <Card title="Named, not found" meta={notFound.length}>
          <p className="text-sm text-[var(--color-fg-2)]">
            Named in the charter; nothing in the documentation says how to reach{' '}
            {notFound.length === 1 ? 'it' : 'them'}. Link a documentation page that does, then
            re-run orientation.
          </p>
          <ul className="mt-3 grid gap-2 text-sm">
            {notFound.map((surface) => (
              <li key={surface._id} className="border-t border-[var(--color-border)] pt-2">
                <p className="font-medium text-[var(--color-fg)]">{surface.displayName}</p>
                {surface.reason ? (
                  <p className="text-[13px] text-[var(--color-muted)]">{surface.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <UnnamedSystemsRow
        error={
          proposeOperation?.error
            ? { surfaceId: proposeOperation.surfaceId, message: proposeOperation.error }
            : undefined
        }
        onPropose={(surfaceId: string): void => {
          const system = awaitingProposal.find((row) => row._id === surfaceId);
          operate(
            'propose',
            { _id: surfaceId as Id<'surfaces'>, slug: system?.slug ?? surfaceId },
            () => requestProposal({ surfaceId: surfaceId as Id<'surfaces'> }),
            {
              done: `Proposal requested for ${system?.displayName ?? 'the system'}; its card appears once it is drafted.`,
              refused: 'The proposal was not requested.',
            },
          );
        }}
        proposing={
          proposeOperation && !proposeOperation.error ? proposeOperation.surfaceId : undefined
        }
        sourceLabels={context.sourceLabels}
        systems={awaitingProposal}
      />
    </>
  );

  const waiting = declared.length + notFound.length;
  return (
    <Columns arriving={arriving} aside={aside}>
      {/* The panel the card links and the Slack OAuth redirect name (`#surfaces`). */}
      <section
        id={ENVIRONMENT_PANEL_ID}
        aria-label="Systems"
        tabIndex={-1}
        className="grid scroll-mt-24 gap-4"
      >
        {/* A refusal is said once, by the alert beside the control that met it; what a change
            that landed came to is said here, once for the tab. */}
        <div className="sr-only">
          <StatusRegion outcome={change.outcome?.tone === 'done' ? change.outcome : null} />
        </div>
        {!loaded ? (
          <p className="text-sm text-[var(--color-muted)]">{LOADING_SURFACES}</p>
        ) : listed.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{EMPTY_SURFACES}</p>
        ) : null}
        {loaded && waiting > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-[var(--color-fg-2)]">
              {[
                declared.length > 0
                  ? `${declared.length} declared ${declared.length === 1 ? 'system has' : 'systems have'} no proposal yet.`
                  : '',
                notFound.length > 0
                  ? `${notFound.length} named ${notFound.length === 1 ? 'system was' : 'systems were'} not found in the documentation.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            </span>
            <Button size="small" onClick={onReorient} disabled={reorienting}>
              {reorienting ? 'Re-running orientation...' : 'Re-run orientation'}
            </Button>
            {reorientError ? (
              <span role="alert" className="text-[var(--color-danger)]">
                {reorientError}
              </span>
            ) : null}
          </div>
        ) : null}
        {loaded
          ? cards.map((surface) => (
              <SurfaceCard
                key={surface._id}
                surface={surface}
                context={context}
                operation={operations[surface._id]}
                actions={actionsFor(surface)}
              />
            ))
          : null}
      </section>
      {children}
    </Columns>
  );
}
