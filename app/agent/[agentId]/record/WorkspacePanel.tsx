import { Card } from '../../../components/Card';
import { Disclosure } from '../../../components/Disclosure';

/** The eight files of the workspace convention, in the order they are listed. */
export const WORKSPACE_FILES = [
  'AGENTS.md',
  'IDENTITY.md',
  'TOOLS.md',
  'SOUL.md',
  'USER.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
  'HEARTBEAT.md',
] as const;

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

/** How many bytes a file's text takes as UTF-8, which is what its size means on disk. */
function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * A size as the files list writes it: bytes below a kilobyte, kilobytes to one place above.
 *
 * @param bytes - The size in bytes.
 */
export function fileSize(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}

/**
 * The employee's eight workspace files behind one disclosure that says how many there are and
 * their size together, each file behind its own with its size, its text one step further in.
 *
 * @param name - The employee's name.
 * @param workspace - Each file's text by name, or undefined while the files load.
 */
export function WorkspacePanel({
  name,
  workspace,
}: {
  name: string;
  workspace: Readonly<Record<string, string>> | undefined;
}) {
  if (workspace === undefined) {
    return (
      <Card title={`${name}'s files`}>
        <p className="text-sm text-[var(--color-muted)]">Loading the files</p>
      </Card>
    );
  }
  const files = WORKSPACE_FILES.map((file) => {
    const content = workspace[file] ?? '';
    return { file, content, bytes: content.trim() === '' ? 0 : byteLength(content) };
  });
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return (
    <Card title={`${name}'s files`}>
      <Disclosure
        summary={`${NUMBER_WORDS[files.length] ?? files.length} files, ${fileSize(total)}`}
      >
        <ul className="grid gap-1">
          {files.map(({ file, content, bytes }) => (
            <li key={file}>
              <details className="group/file">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-1 text-[13px] hover:bg-[var(--color-inset)] [&::-webkit-details-marker]:hidden">
                  <span className="font-mono text-[var(--color-fg)]">{file}</span>
                  <span className="tabular-nums text-[var(--color-muted)]">
                    {bytes === 0 ? 'empty' : fileSize(bytes)}
                  </span>
                </summary>
                <pre
                  tabIndex={0}
                  aria-label={file}
                  className="mt-1 max-h-48 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-[var(--color-fg-2)]"
                >
                  {bytes === 0 ? '(empty)' : content}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      </Disclosure>
    </Card>
  );
}
