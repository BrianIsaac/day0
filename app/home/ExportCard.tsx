'use client';

import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { assembleOwnerExport, OWNER_SECTIONS } from '@/export/trace';
import { saveFile } from '../agent/[agentId]/record/RecordExport';
import { Button } from '../components/Button';
import { StatusRegion } from '../components/StatusRegion';
import { useChange } from '../components/use-change';

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

/**
 * "Export everything" on the home (wave 16, 16-F; the wave file's 5.4 and section 7): every
 * employee's redacted trace and the owner's own rows (the skill library, people, agreements, the
 * documentation's decisions), assembled page by page through the same actions the command line
 * calls, and saved as the one file `metrics:recompute` reads. The outcome is said beside the
 * control.
 */
export function ExportCard() {
  const head = useAction(api.exportActions.exportForOwner);
  const page = useAction(api.exportActions.exportOwnerPage);
  const employeeHead = useAction(api.exportActions.exportForAgent);
  const employeePage = useAction(api.exportActions.exportPage);
  const change = useChange();

  function onExport(): void {
    change.run(
      async () => {
        const file = await assembleOwnerExport({
          head: async () => await head({}),
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
        });
        const fileName = ownerExportFileName(file.manifest.exportedOn);
        saveFile(fileName, `${JSON.stringify(file, null, 2)}\n`);
        const rows = OWNER_SECTIONS.reduce(
          (total, section) => total + file.manifest.counts[section],
          0,
        );
        return { fileName, employees: file.employees.length, rows };
      },
      {
        // An owner who keeps nothing of their own yet has no rows to name (the 16-F bed).
        done: ({ fileName, employees, rows }) =>
          `Exported ${counted(employees, 'employee')}${rows > 0 ? ` and ${counted(rows, 'row')} of yours` : ''} to ${fileName}, redacted as the export's policy says.`,
        refused: 'The export did not finish; nothing was saved.',
      },
    );
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
          <Button size="small" disabled={change.busy} onClick={onExport}>
            {change.busy ? 'Exporting' : 'Export'}
          </Button>
          <StatusRegion outcome={change.outcome} />
        </div>
      </div>
    </section>
  );
}
