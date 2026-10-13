'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
  OWNER_SECTIONS,
  OwnerExportCancelled,
  streamOwnerExport,
  type OwnerExportCalls,
  type OwnerExportProgress,
} from '@/export/trace';
import { dayKey, deploymentZone } from '@/lib/zone';
import { Button } from '../components/Button';
import { StatusRegion } from '../components/StatusRegion';
import { refusalText, useChange } from '../components/use-change';
import { EXPORT_REFUSED, leftBehind, openExportFile } from './export-file';

/**
 * The file the owner export is saved as: the day of the export, as `--out` would be named by hand.
 *
 * @param exportedOn - The export's date, `YYYY-MM-DD`.
 */
export function ownerExportFileName(exportedOn: string): string {
  return `day0-owner-export-${exportedOn}.json`;
}

/** A count in words: "1 employee", "3 rows". */
function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-GB')} ${noun}${count === 1 ? '' : 's'}`;
}

/** What a stopped export says, whoever stopped it (section 7's draft, RM24). */
export const EXPORT_CANCELLED = 'Cancelled: nothing was saved.';

/** How an export ended: saved under a name, or stopped by the manager with nothing kept. */
type Exported =
  | { readonly kind: 'cancelled'; readonly left?: string }
  | {
      readonly kind: 'saved';
      readonly fileName: string;
      readonly employees: number;
      readonly rows: number;
    };

/**
 * "Export everything" on the home (wave 16, 16-F; the wave file's 5.4 and section 7): every
 * employee's redacted trace and the owner's own rows (the skill library, people, agreements, the
 * documentation's decisions), read page by page through the same actions the command line calls
 * and written to the one file `metrics:recompute` reads as each employee's trace arrives (wave
 * 17, 17-F; decision F-1), so the page holds one trace however many employees there are. While it
 * runs the card says how far it has got and offers Cancel, which leaves no file. The outcome is
 * said beside the control.
 */
export function ExportCard() {
  const head = useAction(api.exportActions.exportForOwner);
  const agents = useAction(api.exportActions.exportOwnerAgents);
  const page = useAction(api.exportActions.exportOwnerPage);
  const employeeHead = useAction(api.exportActions.exportForAgent);
  const employeePage = useAction(api.exportActions.exportPage);
  const change = useChange();
  const [progress, setProgress] = useState<OwnerExportProgress | null>(null);
  const running = useRef<AbortController | null>(null);
  // A manager who leaves the page stops the export: no file is written behind their back.
  useEffect(() => (): void => running.current?.abort(), []);

  const calls: OwnerExportCalls = {
    head: async () => await head({}),
    agents: async (cursor) => await agents({ cursor }),
    page: async (cursor) => await page({ section: cursor.section, cursor: cursor.cursor }),
    employee: {
      head: async ({ agentId }) => await employeeHead({ agentId: agentId as Id<'agents'> }),
      page: async ({ agentId, page: at }) =>
        await employeePage({
          agentId: agentId as Id<'agents'>,
          section: at.section,
          cursor: at.cursor,
        }),
    },
  };

  async function exportToFile(signal: AbortSignal): Promise<Exported> {
    // Asked first, inside the press: the browser's picker opens only on the manager's own
    // gesture. The name it offers is the viewer's day; the file's own day is in its manifest.
    const file = await openExportFile(ownerExportFileName(dayKey(Date.now(), deploymentZone())));
    if (file === undefined) return { kind: 'cancelled' };
    try {
      const manifest = await streamOwnerExport(calls, file, { signal, onProgress: setProgress });
      // Cancel pressed as the last piece went: the file is not kept.
      if (signal.aborted) throw new OwnerExportCancelled();
      const fileName = await file.close(ownerExportFileName(manifest.exportedOn));
      const rows = OWNER_SECTIONS.reduce((total, section) => total + manifest.counts[section], 0);
      return { kind: 'saved', fileName, employees: manifest.counts.employees, rows };
    } catch (error) {
      const left = await file.discard();
      if (error instanceof OwnerExportCancelled) return { kind: 'cancelled', left };
      if (left === undefined) throw error;
      throw new Error(`${refusalText(error, EXPORT_REFUSED)}${leftBehind(left)}`);
    } finally {
      setProgress(null);
    }
  }

  function onExport(): void {
    const controller = new AbortController();
    running.current = controller;
    change.run(async () => await exportToFile(controller.signal), {
      done: (exported) =>
        exported.kind === 'cancelled'
          ? `${EXPORT_CANCELLED}${exported.left === undefined ? '' : leftBehind(exported.left)}`
          : // An owner who keeps nothing of their own yet has no rows to name (the 16-F bed).
            `Exported ${counted(exported.employees, 'employee')}${exported.rows > 0 ? ` and ${counted(exported.rows, 'row')} of yours` : ''} to ${exported.fileName}, redacted as the export's policy says.`,
      refused: EXPORT_REFUSED,
    });
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <h2 className="border-b border-[var(--color-border)] px-5 py-4 text-sm font-semibold">
        Everything, for every employee
      </h2>
      <div className="grid gap-3 px-5 py-4">
        <p className="text-sm text-[var(--color-muted)]">
          One file of every employee’s record and what you keep across them: skills, people,
          agreements, documentation decisions.
        </p>
        <div className="grid justify-items-start gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" disabled={change.busy} onClick={onExport}>
              {change.busy ? 'Exporting' : 'Export'}
            </Button>
            {change.busy ? (
              <Button size="small" variant="quiet" onClick={() => running.current?.abort()}>
                Cancel
              </Button>
            ) : null}
          </div>
          {progress !== null ? <ExportProgress progress={progress} /> : null}
          <StatusRegion outcome={change.outcome} />
        </div>
      </div>
    </section>
  );
}

/**
 * How far the export has got, in section 7's words, with a bar a screen reader can ask for: it is
 * not a live region, so fifty employees are not fifty announcements; the outcome is the one said.
 *
 * @param progress - The employees whose traces are written, of those the export names.
 */
function ExportProgress({ progress }: { progress: OwnerExportProgress }) {
  const { written, employees } = progress;
  return (
    <div className="mt-1 grid w-full gap-1">
      <p className="text-xs tabular-nums text-[var(--color-muted)]">
        Exporting {written.toLocaleString('en-GB')} of {counted(employees, 'employee')}
      </p>
      <progress
        aria-label="Employees exported"
        max={Math.max(employees, 1)}
        value={written}
        className="h-1.5 w-full max-w-xs [accent-color:var(--color-accent)]"
      />
    </div>
  );
}
