import Link from 'next/link';

import type {
  HostedDemoSnapshot,
  RecordedAction,
  RecordedCharter,
  RecordedOffice,
  RecordedScope,
  RecordedSkill,
  RecordedTimelineEntry,
  RecordedWorkItem,
  RecordedWorkspaceFile,
} from '@/demo/hosted-demo-snapshot';

/**
 * A recorded run of the product, rendered from the tracked snapshot.
 *
 * Every shape below is the live dashboard's - a work item keeps its verdict,
 * plan and action ledger, a skill its source type and state, the workspace its
 * eight-file convention - so what a visitor sees here is what an owner sees at
 * `/agent/[agentId]`. What it deliberately does not carry over is the dashboard's
 * machinery: no Convex client, no session, no effect, and no control at all.
 * Navigation is anchor links, so the page needs no JavaScript to be usable and
 * cannot reach the backend even if it wanted to.
 */

const CHAPTERS = [
  { id: 'charter', title: 'The charter' },
  { id: 'scope', title: 'What it may touch' },
  { id: 'work', title: 'The work' },
  { id: 'skills', title: 'The missing skill' },
  { id: 'workspace', title: 'Its workspace' },
  { id: 'office', title: 'The office' },
  { id: 'sequence', title: 'The sequence' },
] as const;

type Tone = 'default' | 'accent' | 'warn' | 'ok' | 'muted';

const CHIP_TONE: Record<Tone, string> = {
  default: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
  accent: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
  warn: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
  ok: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
  muted: 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]',
};

/** The dashboard's own mapping from a work-item state to its chip colour. */
function stateTone(state: string): Tone {
  if (state === 'completed') return 'ok';
  if (state === 'plan-pending' || state === 'needs-skill' || state === 'actions-pending')
    return 'warn';
  if (state === 'skipped' || state === 'deferred') return 'muted';
  return 'accent';
}

function Chip({ tone = 'default', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** The offset a moment sits at, in the recording's own clock. */
function At({ at }: { at: string }) {
  return <span className="font-mono text-[10px] text-[var(--color-muted)]">{at}</span>;
}

function Card({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'default' | 'accent' | 'warn' | 'ok';
  children: React.ReactNode;
}) {
  const border = {
    default: 'border-[var(--color-border)]',
    accent: 'border-[var(--color-accent)]/40',
    warn: 'border-[var(--color-warn)]/40',
    ok: 'border-[var(--color-ok)]/40',
  }[tone ?? 'default'];
  return (
    <div className={`bg-[var(--color-card)] border ${border} rounded-xl p-4`}>
      <h3 className="text-sm font-semibold tracking-tight mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Goal({ label, text }: { label: string; text: string }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-2.5">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-xs leading-snug">{text}</div>
    </div>
  );
}

function BoundaryList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      <ul className="space-y-1 text-xs leading-relaxed">
        {items.map((item) => (
          <li key={item}>&ndash; {item}</li>
        ))}
      </ul>
    </div>
  );
}

function Chapter({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  index: number;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-20 border-t border-[var(--color-border)] pt-10"
    >
      <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-3">
        Chapter {index}
      </p>
      <h2 id={`${id}-heading`} className="text-2xl font-semibold tracking-tight mb-3">
        {title}
      </h2>
      <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-6 max-w-2xl">{lede}</p>
      {children}
    </section>
  );
}

function CharterSection({
  charter,
  conversation,
}: {
  charter: RecordedCharter;
  conversation: HostedDemoSnapshot['conversation'];
}) {
  return (
    <div className="space-y-4">
      <Card title="Approval" tone="ok">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Chip tone="ok">approved</Chip>
          <Chip tone="muted">version {charter.version}</Chip>
          <span className="text-xs text-[var(--color-muted)]">
            drafted <At at={charter.draftedAt} /> &middot; approved <At at={charter.approvedAt} />
          </span>
        </div>
        <p className="text-sm text-[var(--color-muted)] leading-relaxed">
          Six seconds of reading, and nothing below this point in the recording happened before it.
          The agent held a drafted charter and no work until the boss approved this version.
        </p>
        <p className="text-xs text-[var(--color-muted)] mt-3">{conversation.note}</p>
        <p className="text-xs text-[var(--color-muted)] mt-2">
          Rooms opened during the 1:1:{' '}
          {conversation.rooms.map((room) => `${room.mode} (${room.state})`).join(', ')}.
        </p>
      </Card>

      <Card title="The role, as approved">
        <div className="space-y-4">
          <Labelled label="Proposed function">{charter.proposedFunction}</Labelled>
          <Labelled label="Why this hire">{charter.whyThisHire}</Labelled>
          <div className="grid gap-2 sm:grid-cols-3">
            <Goal label="30 days" text={charter.shortTermGoals.day30} />
            <Goal label="60 days" text={charter.shortTermGoals.day60} />
            <Goal label="90 days" text={charter.shortTermGoals.day90} />
          </div>
        </div>
      </Card>

      <Card title="Boundaries">
        <div className="space-y-4">
          <BoundaryList label="Will do" items={charter.proposedBoundaries.willDo} />
          <BoundaryList label="Will not do" items={charter.proposedBoundaries.willNotDo} />
          <BoundaryList
            label="Escalates instead"
            items={charter.proposedBoundaries.escalationTriggers}
          />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="People it works with">
          <ul className="space-y-3 text-xs leading-relaxed">
            {charter.namedCollaborators.map((person) => (
              <li key={person.name}>
                <span className="text-sm font-medium">{person.name}</span>
                <p className="text-[var(--color-muted)] mt-0.5">{person.topic}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <BoundaryList
              label="Lanes it stays out of"
              items={charter.adjacentRoles.map(
                (role) => `${role.who}: ${role.staysOutOfTheirLaneBy}`,
              )}
            />
          </div>
        </Card>

        <Card title="What it still does not know">
          <BoundaryList label="Priority reading" items={charter.priorityReading} />
          <div className="mt-4">
            <BoundaryList label="Open questions" items={charter.openQuestions} />
          </div>
          <p className="text-[10px] text-[var(--color-muted)] mt-4">
            Approval chain: {charter.approvalChain.boss} (confidence:{' '}
            {charter.approvalChain.confidence})
          </p>
        </Card>
      </div>

      <Card title="Provenance">
        <p className="text-xs text-[var(--color-muted)] mb-3">
          Every claim above is tagged with the line of the conversation it came from. Source:{' '}
          {charter.source}.
        </p>
        <ul className="space-y-2">
          {charter.evidence.map((quote) => (
            <li
              key={quote.text}
              className="border-l-2 border-[var(--color-accent)]/40 pl-3 text-xs leading-relaxed"
            >
              <span className="block">{quote.text}</span>
              <span className="block text-[10px] text-[var(--color-muted)] mt-1">
                {quote.source}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ScopeSection({ scopes }: { scopes: RecordedScope[] }) {
  return (
    <Card title="Permission scopes held at the end of the recording">
      <ul className="space-y-2">
        {scopes.map((scope) => (
          <li
            key={scope.scope}
            className="flex flex-wrap items-center gap-2 border border-[var(--color-border)] rounded-lg px-3 py-2"
          >
            <span className="font-mono text-xs">{scope.scope}</span>
            <At at={scope.grantedAt} />
            {scope.grantedWithSkill ? (
              <Chip tone="warn">granted with the skill</Chip>
            ) : (
              <Chip tone="muted">granted at deployment</Chip>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--color-muted)] mt-3 leading-relaxed">
        The write scope is the one to look at. The agent did not hold it when it was deployed; it
        arrived with the boss&rsquo;s approval of the skill that needed it, and not a moment before.
      </p>
    </Card>
  );
}

function ActionRow({ action }: { action: RecordedAction }) {
  return (
    <li className="border border-[var(--color-border)] rounded-lg p-2.5">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <span className="font-mono text-[10px] text-[var(--color-muted)]">{action.tool}</span>
        {action.applied ? <Chip tone="ok">applied</Chip> : <Chip tone="muted">not applied</Chip>}
      </div>
      <dl className="space-y-1.5">
        {Object.entries(action.args).map(([key, value]) => (
          <div key={key}>
            <dt className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
              {key}
            </dt>
            <dd className="text-xs leading-relaxed whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function WorkItemCard({ item }: { item: RecordedWorkItem }) {
  return (
    <article className="border border-[var(--color-border)] rounded-xl p-4 bg-[var(--color-card)]">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <Chip tone={stateTone(item.state)}>{item.state}</Chip>
        <span className="text-[10px] text-[var(--color-muted)]">
          {item.sourceSystem}/{item.sourceCategory}
        </span>
        <span className="text-[10px] text-[var(--color-warn)]">{item.priority}</span>
        <span className="text-[10px] text-[var(--color-muted)]">from {item.requesterLabel}</span>
        <At at={item.observedAt} />
      </div>
      <h3 className="text-sm font-medium">{item.title}</h3>
      <p className="text-xs text-[var(--color-muted)] mt-1.5 leading-relaxed">
        {item.contentSummary}
      </p>

      <div className="mt-3 text-[10px] text-[var(--color-muted)] font-mono">
        {item.contentRefs.join(' · ')}
      </div>

      <div className="mt-3 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            Seven-criterion verdict
          </span>
          <Chip tone={item.verdict.decision === 'claim' ? 'accent' : 'muted'}>
            {item.verdict.decision}
          </Chip>
          {item.verdict.value !== null && item.verdict.risk !== null ? (
            <span className="text-[10px] text-[var(--color-muted)]">
              value {item.verdict.value} · risk {item.verdict.risk}
            </span>
          ) : null}
        </div>
        {item.verdict.requiredPermissions.length > 0 ? (
          <p className="text-[10px] text-[var(--color-muted)] font-mono">
            needs {item.verdict.requiredPermissions.join(', ')}
          </p>
        ) : null}
        {item.skipReason ? (
          <p className="text-xs text-[var(--color-muted)] mt-2 leading-relaxed">
            {item.skipReason}
          </p>
        ) : null}
      </div>

      {item.plan ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
              Plan, as the boss approved it
            </span>
            <Chip tone="muted">{item.plan.expectedOutputType}</Chip>
            <span className="text-[10px] text-[var(--color-muted)]">
              ~{item.plan.estimatedMinutes} min
            </span>
          </div>
          <p className="text-xs leading-relaxed">{item.plan.summary}</p>
          <ol className="mt-2 space-y-1 text-xs leading-relaxed list-decimal list-inside text-[var(--color-muted)]">
            {item.plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            <Goal label="Risk" text={item.plan.riskNotes} />
            <Goal label="Reversibility" text={item.plan.reversibility} />
          </div>
        </div>
      ) : null}

      {item.output ? (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
            What reached the office
          </div>
          <ul className="space-y-2">
            {item.output.actions.map((action, index) => (
              <ActionRow key={`${action.tool}-${index}`} action={action} />
            ))}
          </ul>
          {item.output.draft ? (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]">
                The draft the agent wrote before any of it was applied
              </summary>
              <pre className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3">
                {item.output.draft}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function SkillCard({ skill }: { skill: RecordedSkill }) {
  const authored = skill.sourceType === 'agent-authored';
  return (
    <Card title={skill.name} tone={authored ? 'accent' : 'default'}>
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
        <Chip tone={authored ? 'accent' : 'muted'}>{skill.sourceType}</Chip>
        <Chip tone="ok">{skill.state}</Chip>
        <span className="text-[10px] text-[var(--color-muted)]">
          registered <At at={skill.registeredAt} />
        </span>
      </div>
      <p className="text-xs leading-relaxed mb-3">{skill.description}</p>
      {skill.rationale ? (
        <div className="mb-3">
          <Labelled label="Why the agent asked for it">
            <span className="text-xs text-[var(--color-muted)]">{skill.rationale}</span>
          </Labelled>
        </div>
      ) : null}
      {skill.requiredScopes ? (
        <p className="text-[10px] font-mono text-[var(--color-muted)] mb-3">
          scopes requested: {skill.requiredScopes.join(', ')}
        </p>
      ) : null}
      {skill.verificationLog ? (
        <div className="mb-3">
          <Labelled label="Smoke test in the sandbox">
            <pre className="text-[11px] whitespace-pre-wrap bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-2.5">
              {skill.verificationLog}
            </pre>
          </Labelled>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]">
          {skill.bodyExcerpted ? 'The opening of the skill it wrote' : 'The skill itself'}
        </summary>
        <pre className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 max-h-96 overflow-auto">
          {skill.body}
        </pre>
      </details>
    </Card>
  );
}

function WorkspaceSection({ files }: { files: RecordedWorkspaceFile[] }) {
  return (
    <Card title="Workspace · 8-file convention">
      <div className="space-y-1.5">
        {files.map((file) => (
          <details key={file.fileName}>
            <summary className="cursor-pointer px-2 py-1.5 rounded hover:bg-[var(--color-bg)] flex items-center justify-between gap-3">
              <span className="font-mono text-xs">{file.fileName}</span>
              <span className="text-[10px] text-[var(--color-muted)] flex-1 text-left">
                {file.purpose}
              </span>
              <span className="text-[10px] text-[var(--color-muted)]">{file.bytes}b</span>
            </summary>
            <pre className="mt-1 ml-2 text-[11px] leading-relaxed text-[var(--color-muted)] whitespace-pre-wrap max-h-64 overflow-auto bg-[var(--color-bg)] p-2.5 rounded border border-[var(--color-border)]">
              {file.excerpt}
            </pre>
          </details>
        ))}
      </div>
    </Card>
  );
}

function Surface({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <details className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl">
      <summary className="cursor-pointer px-4 py-3 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold tracking-tight">{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-muted)]/15 text-[var(--color-muted)]">
          {count}
        </span>
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

function OfficeSection({ office }: { office: RecordedOffice }) {
  return (
    <div className="space-y-3">
      <Surface title="Slack" count={office.messages.length}>
        <div className="space-y-4">
          {office.channels.map((channel) => {
            const messages = office.messages.filter((m) => m.channelSlug === channel.slug);
            return (
              <div key={channel.slug}>
                <p className="text-xs font-medium mb-1.5">
                  {channel.displayName}{' '}
                  <span className="text-[10px] text-[var(--color-muted)]">{channel.kind}</span>
                </p>
                {messages.length === 0 ? (
                  <p className="text-[10px] text-[var(--color-muted)]">
                    No message in this recording.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {messages.map((message, index) => (
                      <li
                        key={`${channel.slug}-${index}`}
                        className="border border-[var(--color-border)] rounded-lg p-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-xs font-medium">{message.sender}</span>
                          <Chip tone={message.senderKind === 'agent-draft' ? 'warn' : 'muted'}>
                            {message.senderKind}
                          </Chip>
                          <At at={message.at} />
                        </div>
                        <p className="text-xs leading-relaxed whitespace-pre-wrap">
                          {message.body}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Surface>

      <Surface title={office.spreadsheet.title} count={office.spreadsheet.rows.length}>
        {office.spreadsheet.tabs.map((tab) => {
          const rows = office.spreadsheet.rows.filter((row) => row.tabName === tab.name);
          return (
            <div key={tab.name} className="mb-4">
              <p className="text-xs font-medium mb-1.5">{tab.name}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr>
                      {tab.headers.map((header) => (
                        <th
                          key={header}
                          scope="col"
                          className="text-left text-[10px] uppercase tracking-wider text-[var(--color-muted)] border-b border-[var(--color-border)] py-1.5 pr-3"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={tab.headers.length}
                          className="py-1.5 text-[var(--color-muted)]"
                        >
                          No row in this recording.
                        </td>
                      </tr>
                    ) : (
                      rows.map((row, index) => (
                        <tr key={`${tab.name}-${index}`}>
                          {tab.headers.map((header) => (
                            <td
                              key={header}
                              className="py-1.5 pr-3 border-b border-[var(--color-border)]"
                            >
                              {row.cells[header] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </Surface>

      <Surface title="Docs" count={office.docs.length}>
        <ul className="space-y-1.5">
          {office.docs.map((doc) => (
            <li key={doc.slug}>
              <details>
                <summary className="cursor-pointer px-2 py-1.5 rounded hover:bg-[var(--color-bg)] flex items-center justify-between gap-3">
                  <span className="text-xs">{doc.title}</span>
                  <Chip tone="muted">{doc.category}</Chip>
                </summary>
                <pre className="mt-1 ml-2 text-[11px] leading-relaxed text-[var(--color-muted)] whitespace-pre-wrap max-h-64 overflow-auto bg-[var(--color-bg)] p-2.5 rounded border border-[var(--color-border)]">
                  {doc.body}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      </Surface>

      <Surface title="Tickets" count={office.tickets.length}>
        <ul className="space-y-2">
          {office.tickets.map((ticket) => (
            <li key={ticket.slug} className="border border-[var(--color-border)] rounded-lg p-2.5">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-mono text-[10px] text-[var(--color-muted)]">
                  {ticket.slug}
                </span>
                <Chip tone={ticket.status === 'open' ? 'muted' : 'warn'}>{ticket.status}</Chip>
                <span className="text-[10px] text-[var(--color-warn)]">{ticket.priority}</span>
              </div>
              <p className="text-xs font-medium">{ticket.title}</p>
              <p className="text-xs text-[var(--color-muted)] mt-1 leading-relaxed">
                {ticket.body}
              </p>
              {ticket.comments.map((comment, index) => (
                <div
                  key={`${ticket.slug}-${index}`}
                  className="mt-2 pl-3 border-l-2 border-[var(--color-border)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium">{comment.author}</span>
                    <At at={comment.at} />
                  </div>
                  <p className="text-xs text-[var(--color-muted)] leading-relaxed">
                    {comment.body}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      </Surface>

      <Surface title="Social mention" count={1}>
        <div className="border border-[var(--color-border)] rounded-lg p-2.5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium">{office.socialMention.author}</span>
            <span className="text-[10px] text-[var(--color-muted)]">
              {office.socialMention.handle}
            </span>
          </div>
          <p className="text-xs leading-relaxed">{office.socialMention.body}</p>
        </div>
      </Surface>
    </div>
  );
}

function Timeline({ entries }: { entries: RecordedTimelineEntry[] }) {
  return (
    <ol className="space-y-2">
      {entries.map((entry, index) => (
        <li
          key={`${entry.at}-${index}`}
          className="flex gap-3 border border-[var(--color-border)] rounded-lg px-3 py-2"
        >
          <At at={entry.at} />
          <div className="flex-1">
            <p className="text-xs">
              <span className="font-medium">{entry.label}</span>
              {entry.subject ? (
                <span className="text-[var(--color-muted)]"> &middot; {entry.subject}</span>
              ) : null}
            </p>
            {entry.detail ? (
              <p className="text-[10px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                {entry.detail}
              </p>
            ) : null}
          </div>
          <span className="font-mono text-[10px] text-[var(--color-muted)] hidden sm:block">
            {entry.type}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function DemoWalkthrough({ snapshot }: { snapshot: HostedDemoSnapshot }) {
  const { recording, agent, charter, scopes, workItems, skills, office, timeline } = snapshot;
  return (
    <main className="min-h-[calc(100vh-3.25rem)] px-6 py-12 max-w-4xl mx-auto w-full">
      <header className="mb-10">
        <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-4">
          {recording.label}
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight mb-5">
          {recording.headline}
        </h1>
        <div
          role="note"
          className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-4 mb-5"
        >
          <p className="text-sm leading-relaxed">{recording.readOnly}</p>
          <p className="text-xs text-[var(--color-muted)] mt-2 leading-relaxed">
            {recording.sanitised}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <Chip tone="accent">{agent.name}</Chip>
          <Chip tone="ok">{agent.state}</Chip>
          <span>
            {recording.clock} The recording runs to <At at={recording.spanLabel} />.
          </span>
        </div>
      </header>

      <nav aria-label="Walkthrough chapters" className="mb-12">
        <ol className="flex flex-wrap gap-2">
          {CHAPTERS.map((chapter, index) => (
            <li key={chapter.id}>
              <a
                href={`#${chapter.id}`}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs hover:border-[var(--color-accent)]"
              >
                <span className="font-mono text-[10px] text-[var(--color-muted)]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {chapter.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-12">
        <Chapter
          id="charter"
          index={1}
          title="The charter"
          lede="The agent arrived with a name and nothing else. It ran its own Day-1 1:1, wrote this charter from what it heard, and then waited."
        >
          <CharterSection charter={charter} conversation={snapshot.conversation} />
        </Chapter>

        <Chapter
          id="scope"
          index={2}
          title="What it may touch"
          lede="Scopes are granted, not assumed. Five arrived when the agent was deployed; the sixth had to be asked for."
        >
          <ScopeSection scopes={scopes} />
        </Chapter>

        <Chapter
          id="work"
          index={3}
          title="The work"
          lede="Three candidates were surfaced from the office. A seven-criterion evaluator decided what to claim, the boss approved each plan, and only then did anything reach the office."
        >
          <div className="space-y-4">
            {workItems.map((item) => (
              <WorkItemCard key={item.id} item={item} />
            ))}
          </div>
        </Chapter>

        <Chapter
          id="skills"
          index={4}
          title="The missing skill"
          lede="One item needed something the agent did not have. It proposed a skill, the boss approved it, and it was written and smoke-tested in a sandbox before it became callable."
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                {snapshot.skillLoopNote}
              </p>
            </div>
            {skills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </Chapter>

        <Chapter
          id="workspace"
          index={5}
          title="Its workspace"
          lede="Eight files the agent keeps for itself. The charter, the habits it researched for the approved role, and who it reports to."
        >
          <WorkspaceSection files={snapshot.workspace} />
        </Chapter>

        <Chapter
          id="office"
          index={6}
          title="The office"
          lede="The mock workplace the work was done against: a Slack, a tracker, a docs wiki, a ticket queue and one social mention."
        >
          <OfficeSection office={office} />
        </Chapter>

        <Chapter
          id="sequence"
          index={7}
          title="The sequence"
          lede="Every recorded moment, in order. Read it top to bottom and the shape of the gate is visible: nothing lands before an approval."
        >
          <Timeline entries={timeline} />
        </Chapter>
      </div>

      <footer className="mt-16 pt-8 border-t border-[var(--color-border)]">
        <p className="text-sm text-[var(--color-muted)] leading-relaxed">
          This is a recording of one run, not a live agent.{' '}
          <Link href="/setup" className="text-[var(--color-accent)] underline underline-offset-4">
            Set up Day0
          </Link>{' '}
          to run your own, or go back to the{' '}
          <Link href="/" className="text-[var(--color-accent)] underline underline-offset-4">
            overview
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}
