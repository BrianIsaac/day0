'use client';

import { useId, useState, useRef } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';

type PermissionSource = 'deploy' | 'manager' | 'skill' | 'surface';

/** One permission scope as the panel shows it, with whether it is active. */
export interface PermissionScopeView {
  scope: string;
  active: boolean;
  source: PermissionSource;
  grantedAt: number;
  revokedAt: number | null;
}

/** Where a grant came from, in the manager's words. */
const PERMISSION_SOURCE_WORDS: Readonly<Record<PermissionSource, string>> = {
  deploy: 'at deploy',
  manager: 'by you',
  skill: 'with a skill you approved',
  surface: 'with a surface card you approved',
};

/** The permission scopes with their revoke controls. */
export function PermissionRows({
  scopes,
  confirmingScope,
  busyScope,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
  onRegrant,
}: {
  scopes: PermissionScopeView[];
  confirmingScope: string | null;
  busyScope: string | null;
  onAskRevoke: (scope: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (scope: string) => void;
  onRegrant: (scope: string) => void;
}) {
  const id = useId();
  return (
    <ul className="grid gap-2 text-sm">
      {scopes.map((row) => {
        const confirming = confirmingScope === row.scope;
        const busy = busyScope !== null;
        return (
          <li key={row.scope} className="rounded-lg bg-[var(--color-inset)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[13px] break-all text-[var(--color-fg)]">
                  {row.scope}
                </p>
                <p className="text-[13px] text-[var(--color-muted)]">
                  {row.active
                    ? `Granted ${PERMISSION_SOURCE_WORDS[row.source]}`
                    : `Revoked; it was granted ${PERMISSION_SOURCE_WORDS[row.source]}`}
                </p>
              </div>
              {/* One button whose word follows the grant, so focus stays on it
                  when a revoke or a re-grant flips the row. */}
              <Button
                id={permissionControlId(id, row.scope)}
                size="small"
                variant={row.active ? 'danger' : 'secondary'}
                disabled={busy}
                aria-label={`${row.active ? 'Revoke' : 'Re-grant'} ${row.scope}`}
                aria-expanded={row.active ? confirming : undefined}
                onClick={() => (row.active ? onAskRevoke(row.scope) : onRegrant(row.scope))}
                className="shrink-0"
              >
                {row.active ? 'Revoke' : 'Re-grant'}
              </Button>
            </div>
            {confirming ? (
              <div
                role="group"
                aria-label={`Revoke ${row.scope}?`}
                className="mt-2 border-t border-[var(--color-border)] pt-2"
              >
                <p className="mb-2 text-sm text-[var(--color-fg-2)]">
                  Revoke {row.scope}? Day0 will stop queued and in-flight work that still needs this
                  standing scope at its final authority check. Actions already approved by you keep
                  their exact approval; a provider call past its final authority check may still
                  finish.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() => onRevoke(row.scope)}
                  >
                    Confirm revoke
                  </Button>
                  <Button
                    size="small"
                    autoFocus
                    disabled={busy}
                    onClick={() => {
                      onCancelRevoke();
                      document.getElementById(permissionControlId(id, row.scope))?.focus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      onCancelRevoke();
                      document.getElementById(permissionControlId(id, row.scope))?.focus();
                    }}
                  >
                    Keep grant
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The id of a permission row's revoke or re-grant button, unique on the page:
 * every character an id cannot hold is spelt by its code, so `a:b` and `a-b`
 * stay two ids.
 *
 * @param list - The permission list's own id.
 * @param scope - The row's scope.
 */
function permissionControlId(list: string, scope: string): string {
  return `${list}-${scope.replace(/[^A-Za-z0-9]/g, (character) => `_${character.charCodeAt(0)}_`)}`;
}

/**
 * What revoking a grant does, including the manager channel's own scope:
 * the DM to the manager is authorised by `boss:message` (or the chat
 * surface's write scope, which is never standing), and every new item needs
 * a way to reach the manager, so its evaluation waits for the grant (U3 D5).
 */
export const PERMISSIONS_NOTE =
  "Reads and manager messages stop when their grant is revoked. A literal write you approve remains authorised by that exact approval. boss:message is the manager channel's own scope: revoking it makes the channel one-way, so Day0 stops messaging you there and decisions wait on this dashboard, and new work waits until you grant it again.";

/** The employee's grants, each with its revoke or re-grant, under what revoking does. Real mode only. */
export function PermissionsCard({ agentId }: { agentId: Id<'agents'> }) {
  const scopes = useQuery(api.agents.permissionScopes, { agentId });
  const revokeScope = useMutation(api.agents.revokeScope);
  const grantScopes = useMutation(api.agents.grantScopes);
  const [confirmingScope, setConfirmingScope] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const control = useRef<string | null>(null);
  const change = useChange(card);

  function decide(scope: string, kind: 'revoke' | 'grant'): void {
    setBusyScope(scope);
    // The confirmation closes with the revoke, so focus goes to the row's own
    // button, which now reads Re-grant.
    control.current = document.activeElement?.closest('li')?.querySelector('button')?.id ?? null;
    change.run<unknown>(
      () =>
        kind === 'revoke'
          ? revokeScope({
              agentId,
              scope,
              reason: "Revoked by the manager from the employee's dashboard.",
            })
          : grantScopes({ agentId, scopes: [scope] }),
      {
        done:
          kind === 'revoke'
            ? `Revoked ${scope}: work that still needs it stops at its final authority check.`
            : `Granted ${scope} again.`,
        refused: kind === 'revoke' ? `${scope} was not revoked.` : `${scope} was not granted.`,
        after: () => setConfirmingScope(null),
        focus: () => (control.current ? document.getElementById(control.current) : null),
      },
    );
  }

  // Busy follows the change, so the rows wait for it and let go together.
  const pending = change.busy ? busyScope : null;
  return (
    <Card title="Permissions" focusRef={card}>
      <p className="mb-3 text-sm leading-relaxed text-[var(--color-fg-2)]">{PERMISSIONS_NOTE}</p>
      {scopes === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the permissions…</p>
      ) : scopes.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No permission has been granted yet.</p>
      ) : (
        <PermissionRows
          scopes={scopes}
          confirmingScope={confirmingScope}
          busyScope={pending}
          onAskRevoke={(scope) => {
            change.clear();
            setConfirmingScope(scope);
          }}
          onCancelRevoke={() => setConfirmingScope(null)}
          onRevoke={(scope) => decide(scope, 'revoke')}
          onRegrant={(scope) => decide(scope, 'grant')}
        />
      )}
      <StatusRegion outcome={change.outcome} />
    </Card>
  );
}
