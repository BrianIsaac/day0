/// <reference types="node" />
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The install record (the access plan, section 4.8; D3 with B11): one page for the customer's IT
 * saying what the install registered, where, with which scopes and modes, and when each secret
 * expires. It names identifiers and addresses only, never a secret, and lives outside the
 * checkout (beside the backups' `~/day0-backups/<project>`), since it describes the customer's
 * systems rather than the code.
 *
 * Since wave 17 (17-P) it also says what was installed: the release and commit, the backend
 * image by its id and the base it was built from, the backend's public origin, what the proxy
 * check found and where the backups go. `install` writes that whatever halves ran, and `upgrade`,
 * `backup` and `restore` each add a dated section naming the backup and its checksum, so the page
 * answers "what is running here, and what do I put back" without the checkout.
 */

/** The company sign-in as the install registered it. */
export interface RecordedSignIn {
  readonly issuer: string;
  readonly clientId: string;
  readonly allowedDomains: string;
  readonly redirectUri: string;
  readonly signedOutUri: string;
}

/** One organisation connection as the install left it. */
export interface RecordedConnection {
  readonly displayName: string;
  readonly system: string;
  /** The mode in words: "per employee" or "shared". */
  readonly mode: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly clientCredentialsScopes?: readonly string[];
  readonly clientId?: string;
  readonly redirectUrl?: string;
  readonly issuer?: string;
  /** The secret's lifetime and what renews it, as the recipe words it. */
  readonly secretLifetime: string;
  /** The day the secret expires, where the recipe gives its lifetime as a number of days. */
  readonly secretExpires?: Date;
  /** What this run did: landed it, or found it already connected and left it. */
  readonly outcome: 'landed' | 'already connected';
  readonly guide: string;
}

/** A system the documentation names that this install did not connect, and why. */
export interface RecordedSkip {
  readonly system: string;
  readonly reason: string;
}

/** Everything one install record says. */
export interface InstallRecord {
  readonly project: string;
  readonly recordedAt: Date;
  readonly publicUrl?: string;
  readonly administrators: readonly string[];
  readonly signIn?: RecordedSignIn;
  readonly connections: readonly RecordedConnection[];
  readonly skipped: readonly RecordedSkip[];
  /** The check the run ended on, and how it exited. */
  readonly check?: { readonly command: string; readonly status: number };
}

/** The backend image a deployment runs, read from its container and never from the machine-wide tag. */
export interface RecordedImage {
  readonly id: string;
  /** The digest of the pinned base it was built from (the `dev.dayzer0.backend.base` label). */
  readonly base?: string;
}

/** What is installed: which code, which image, at which addresses, and where its backups go. */
export interface RecordedInstallation {
  readonly release?: string;
  readonly commit?: string;
  readonly publicUrl?: string;
  /** The origin people's browsers reach the backend on, when the install is behind a proxy. */
  readonly backendUrl?: string;
  readonly image?: RecordedImage;
  readonly backupDirectory?: string;
}

/** One step of `./setup.sh install` and how it ended. */
export interface RecordedStep {
  readonly step: string;
  readonly outcome: string;
}

/** One run of the install verb: what is installed, the sign-in, each step and the proxy check. */
export interface InstallRunRecord {
  readonly project: string;
  readonly recordedAt: Date;
  readonly installation: RecordedInstallation;
  readonly signIn?: RecordedSignIn;
  readonly steps: readonly RecordedStep[];
  /** The proxy check's rows as it printed them; absent when the install stopped before it. */
  readonly proxy?: readonly string[];
}

/** A backup as the record names it: where it is, its checksum, and whose rows it holds. */
export interface RecordedBackup {
  readonly file: string;
  readonly sha256: string;
  /** The release the deployment's rows were stamped at when it was taken. */
  readonly rowsRelease?: string;
  /** The commit that stamped those rows: the checkout to restore from (17-K's F5). */
  readonly rowsCommit?: string;
  /** The commit of the checkout that took it, which after an upgrade's pull is the newer one. */
  readonly takenByCommit?: string;
}

/** One run of `upgrade`, `backup` or `restore`, as a section of the day's record. */
export interface LifecycleRecord {
  readonly verb: 'upgrade' | 'backup' | 'restore';
  readonly project: string;
  readonly recordedAt: Date;
  /** How it ended: completed, or where it stopped. */
  readonly outcome: string;
  readonly installation: RecordedInstallation;
  /** For an upgrade: the release the deployment was at, when its stamp could be read. */
  readonly fromRelease?: string;
  /** The backup this run took: an upgrade's or a restore's safety copy, or the backup itself. */
  readonly backup?: RecordedBackup;
  /** For a restore: the backup that was put back. */
  readonly restored?: RecordedBackup;
  /** For an upgrade: the line it printed for the way back. */
  readonly wayBack?: string;
}

/** The record's file name for a day: one per day, each later run the same day added to it. */
export function installRecordName(at: Date): string {
  return `install-record-${at.toISOString().slice(0, 10)}.md`;
}

/**
 * Where the record is written by default: `~/day0-install/<project>`.
 *
 * @param home - The operator's home directory.
 * @param project - The Compose project the install set up.
 */
export function defaultInstallRecordDirectory(home: string, project: string): string {
  return join(home, 'day0-install', project);
}

/** One bullet per value, none for a value the install did not set. */
function bullets(entries: ReadonlyArray<readonly [string, string | undefined]>): string[] {
  return entries
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1] !== '',
    )
    .map(([label, value]) => `- ${label}: ${value}`);
}

/**
 * The record as Markdown, for a day's first run: the title, what it holds, then the run.
 *
 * @param record - What the install registered.
 */
export function installRecordMarkdown(record: InstallRecord): string {
  return `${installRecordTitle(record.project)}${installRecordRunMarkdown(record)}`;
}

/**
 * How a day's record opens, whichever verb writes its first section.
 *
 * @param project - The Compose project the install set up.
 */
export function installRecordTitle(project: string): string {
  return [
    `# Day0 install record: ${project}`,
    '',
    'Written by `./setup.sh install`, `access`, `upgrade`, `backup` and `restore`, one section ' +
      'per run that day, the latest last. It names what was installed, registered and backed up, ' +
      'and where; it holds no secret. A backup it names does hold the deployment’s keys: keep ' +
      'that where you keep secrets. Keep this page with the customer’s IT.',
    '',
    '',
  ].join('\n');
}

/**
 * Add one section to the day's record, opening the record when the day has none: a later run is
 * added below the earlier ones, never in their place (R41V-12).
 *
 * @param input.directory - Where the record lives.
 * @param input.at - When the run happened, which names the day's file.
 * @param input.project - The Compose project, for a new record's title.
 * @param input.section - The run's section, as Markdown.
 * @returns The record's path.
 */
export function writeInstallRecordSection(input: {
  readonly directory: string;
  readonly at: Date;
  readonly project: string;
  readonly section: string;
}): string {
  mkdirSync(input.directory, { recursive: true });
  const path = join(input.directory, installRecordName(input.at));
  if (existsSync(path)) {
    appendFileSync(path, `\n${input.section}`, { encoding: 'utf8' });
  } else {
    writeFileSync(path, `${installRecordTitle(input.project)}${input.section}`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  return path;
}

/** The lines that say what is installed, none for a value the run could not read. */
function installationBullets(installation: RecordedInstallation): string[] {
  const { image } = installation;
  return bullets([
    ['Release', installation.release === undefined ? undefined : `v${installation.release}`],
    ['Commit', installation.commit],
    ['Day0’s public address', installation.publicUrl],
    ['The backend’s public address', installation.backendUrl],
    ['Backend image', image?.id],
    [
      'Built from the pinned backend',
      image === undefined ? undefined : (image.base ?? 'not labelled: built by another checkout'),
    ],
    ['Backups go to', installation.backupDirectory],
  ]);
}

/** A backup's lines: where it is, its checksum, and which checkout its rows came from. */
function backupBullets(label: string, backup: RecordedBackup): string[] {
  const rows =
    backup.rowsRelease === undefined
      ? undefined
      : `v${backup.rowsRelease}` +
        (backup.rowsCommit === undefined ? '' : `, stamped by commit ${backup.rowsCommit}`);
  return bullets([
    [label, backup.file],
    ['Its sha256', backup.sha256],
    ['Its rows are at', rows],
    ['Taken by the checkout at commit', backup.takenByCommit],
  ]);
}

/**
 * One run of the install verb as a section of the day's record: what is installed, the company
 * sign-in, how each step ended and what the proxy check found. Written whichever steps ran, so an
 * install that stopped at the sign-in still says which release and image it stopped on.
 *
 * @param record - What the run installed and how it went.
 */
export function installRecordInstallMarkdown(record: InstallRunRecord): string {
  const lines: string[] = [
    `## The install of ${record.recordedAt.toISOString()}`,
    '',
    '### What is installed',
    '',
    ...installationBullets(record.installation),
    '',
  ];
  if (record.signIn !== undefined) {
    lines.push(
      '### The company sign-in',
      '',
      ...bullets([
        ['Issuer', record.signIn.issuer],
        ['Client id', record.signIn.clientId],
        ['Allowed domains', record.signIn.allowedDomains],
        ['Redirect URI registered at the issuer', record.signIn.redirectUri],
        ['Sign-out return URI', record.signIn.signedOutUri],
        ['Client secret', 'kept in the install’s .env.local; its expiry is the issuer’s'],
      ]),
      '',
    );
  }
  lines.push('### The steps', '');
  for (const step of record.steps) lines.push(`- ${step.step}: ${step.outcome}`);
  lines.push('');
  if (record.proxy !== undefined) {
    lines.push('### The reverse proxy', '');
    if (record.proxy.length === 0) {
      lines.push('- Not checked: the public address is this machine itself.');
    }
    for (const row of record.proxy) lines.push(`- ${row}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * One run of `upgrade`, `backup` or `restore` as a section of the day's record: which release and
 * image the deployment is on after it, the backup it took and its checksum, what a restore put
 * back, and for an upgrade the way back.
 *
 * @param record - What the run did.
 */
export function installRecordLifecycleMarkdown(record: LifecycleRecord): string {
  const lines: string[] = [
    `## The ${record.verb} of ${record.recordedAt.toISOString()}`,
    '',
    ...bullets([
      ['Outcome', record.outcome],
      [
        'From release',
        record.verb !== 'upgrade'
          ? undefined
          : record.fromRelease === undefined
            ? 'not read (the backend was not running when the upgrade began)'
            : `v${record.fromRelease}`,
      ],
    ]),
    ...installationBullets(record.installation),
    '',
  ];
  if (record.restored !== undefined) {
    lines.push('### What was put back', '', ...backupBullets('Backup', record.restored), '');
  }
  if (record.backup !== undefined) {
    const heading =
      record.verb === 'restore' ? '### What it replaced, backed up first' : '### The backup taken';
    lines.push(heading, '', ...backupBullets('Backup', record.backup), '');
  }
  if (record.wayBack !== undefined) lines.push('### The way back', '', record.wayBack, '');
  return lines.join('\n');
}

/**
 * One run of the access verb as a section of the day's record: a later run the same day is added
 * below the earlier ones, never in their place (R41V-12: a second run that day replaced the
 * record, and the connection the first run landed was no longer in it).
 *
 * @param record - What this run registered.
 */
export function installRecordRunMarkdown(record: InstallRecord): string {
  const lines: string[] = [
    `## The run of ${record.recordedAt.toISOString()}`,
    '',
    ...bullets([
      ['Day0’s public address', record.publicUrl],
      [
        'Administrators (manage the organisation’s connections)',
        record.administrators.length > 0 ? record.administrators.join(', ') : 'none named',
      ],
    ]),
    '',
  ];
  if (record.signIn !== undefined) {
    lines.push(
      '### The company sign-in',
      '',
      ...bullets([
        ['Issuer', record.signIn.issuer],
        ['Client id', record.signIn.clientId],
        ['Allowed domains', record.signIn.allowedDomains],
        ['Redirect URI registered at the issuer', record.signIn.redirectUri],
        ['Sign-out return URI', record.signIn.signedOutUri],
        ['Client secret', 'kept in the install’s .env.local; its expiry is the issuer’s'],
      ]),
      '',
    );
  }
  lines.push('### The organisation’s connections', '');
  if (record.connections.length === 0) lines.push('None was connected by this run.', '');
  for (const connection of record.connections) {
    lines.push(
      `#### ${connection.displayName}, ${connection.mode}`,
      '',
      ...bullets([
        ['System key', connection.system],
        ['Kind', connection.kind],
        ['This run', connection.outcome],
        [
          'Scopes',
          connection.scopes.length > 0 ? connection.scopes.join(', ') : 'as the server offers',
        ],
        ['Client-credentials scopes (fixed)', connection.clientCredentialsScopes?.join(', ')],
        ['Client id', connection.clientId],
        ['Authorisation server', connection.issuer],
        ['Redirect URI registered', connection.redirectUrl],
        ['Secret’s lifetime', connection.secretLifetime],
        ['Secret expires', connection.secretExpires?.toISOString().slice(0, 10)],
        ['Recipe', connection.guide],
      ]),
      '',
    );
  }
  if (record.skipped.length > 0) {
    lines.push('### Named by the documentation, not connected', '');
    for (const skip of record.skipped) lines.push(`- ${skip.system}: ${skip.reason}`);
    lines.push('');
  }
  if (record.check !== undefined) {
    lines.push(
      '### The check',
      '',
      `\`${record.check.command}\` exited ${record.check.status}` +
        `${record.check.status === 0 ? ': every connection passed.' : ': see its output for each gap.'}`,
      '',
    );
  }
  return lines.join('\n');
}
