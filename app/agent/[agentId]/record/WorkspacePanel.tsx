import { Card } from '../../../components/Card';

/** The employee's eight workspace files, each behind a disclosure with its size. */
export function WorkspacePanel({ workspace }: { workspace: Record<string, string> }) {
  const fileOrder = [
    'AGENTS.md',
    'IDENTITY.md',
    'TOOLS.md',
    'SOUL.md',
    'USER.md',
    'BOOTSTRAP.md',
    'MEMORY.md',
    'HEARTBEAT.md',
  ];
  return (
    <Card title="Workspace · 8-file convention">
      <div className="space-y-1 text-xs">
        {fileOrder.map((name) => {
          const content = workspace[name] ?? '';
          const empty = !content.trim();
          return (
            <details key={name}>
              <summary
                className={`min-h-11 cursor-pointer px-2 rounded hover:bg-[var(--color-bg)] flex items-center justify-between ${
                  empty ? 'text-[var(--color-muted)]' : 'text-[var(--color-fg)]'
                }`}
              >
                <span className="font-mono">{name}</span>
                <span className="text-[10px]">{empty ? '∅' : `${content.length}b`}</span>
              </summary>
              <pre
                tabIndex={0}
                role="region"
                aria-label={name}
                className="mt-1 ml-2 text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]"
              >
                {empty ? '(empty)' : content}
              </pre>
            </details>
          );
        })}
      </div>
    </Card>
  );
}
