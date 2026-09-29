'use client';

import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { assembleTrace, type AgentTrace } from '@/export/trace';
import { Button } from '../../../components/Button';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';

/**
 * The file an export is saved as: the employee's name made safe for a file name, and the day of
 * the export in the employee's zone, as the command line's `--out` would be named by hand.
 *
 * @param name - The employee's name.
 * @param exportedOn - The export's date, `YYYY-MM-DD`.
 */
export function exportFileName(name: string, exportedOn: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `day0-trace-${slug || 'employee'}-${exportedOn}.json`;
}

/** How many rows a trace carries across its sections. */
function rowCount(trace: AgentTrace): number {
  return Object.values(trace.manifest.counts).reduce((total, count) => total + count, 0);
}

/**
 * Hand the browser a file to save, from text built on the page.
 *
 * @param fileName - What the file is called.
 * @param text - Its contents.
 */
export function saveFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next task: some browsers cancel a download whose URL goes before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Export on the Record tab (Q14): the employee's whole redacted trace, assembled page by page
 * through the same actions the command line calls, and saved as the one JSON file
 * `metrics:recompute` reads. The outcome is said beside the control.
 *
 * @param agentId - The employee to export.
 * @param name - Its name, for the file.
 */
export function RecordExport({ agentId, name }: { agentId: Id<'agents'>; name: string }) {
  const head = useAction(api.exportActions.exportForAgent);
  const page = useAction(api.exportActions.exportPage);
  const change = useChange();

  function onExport(): void {
    change.run(
      async () => {
        const trace = await assembleTrace(agentId, {
          head: async () => await head({ agentId }),
          page: async (request) =>
            await page({
              agentId,
              section: request.page.section,
              cursor: request.page.cursor,
            }),
        });
        const fileName = exportFileName(name, trace.manifest.exportedOn);
        saveFile(fileName, `${JSON.stringify(trace, null, 2)}\n`);
        return { fileName, rows: rowCount(trace) };
      },
      {
        done: ({ fileName, rows }) =>
          `Exported ${rows.toLocaleString('en-GB')} ${rows === 1 ? 'row' : 'rows'} to ${fileName}, redacted as the export's policy says.`,
        refused: 'The export did not finish; nothing was saved.',
      },
    );
  }

  return (
    <div className="grid justify-items-end gap-1">
      <Button size="small" disabled={change.busy} onClick={onExport}>
        {change.busy ? 'Exporting' : 'Export'}
      </Button>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}
