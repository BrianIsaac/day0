/// <reference types="node" />
import { join } from 'node:path';

/*
 * The install record (the access plan, section 4.8; D3 with B11): one page for the customer's IT
 * saying what the install registered, where, with which scopes and modes, and when each secret
 * expires. It names identifiers and addresses only, never a secret, and lives outside the
 * checkout (beside the backups' `~/day0-backups/<project>`), since it describes the customer's
 * systems rather than the code.
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

/** The record's file name for a day: one per day, a later run the same day replacing it. */
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
 * The record as Markdown.
 *
 * @param record - What the install registered.
 */
export function installRecordMarkdown(record: InstallRecord): string {
  const lines: string[] = [
    `# Day0 install record: ${record.project}`,
    '',
    `Written ${record.recordedAt.toISOString()} by \`./setup.sh access\`. It names what was ` +
      'registered and where; it holds no secret. Keep it with the customer’s IT.',
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
      '## The company sign-in',
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
  lines.push('## The organisation’s connections', '');
  if (record.connections.length === 0) lines.push('None was connected by this run.', '');
  for (const connection of record.connections) {
    lines.push(
      `### ${connection.displayName}, ${connection.mode}`,
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
        ['Recipe', connection.guide],
      ]),
      '',
    );
  }
  if (record.skipped.length > 0) {
    lines.push('## Named by the documentation, not connected', '');
    for (const skip of record.skipped) lines.push(`- ${skip.system}: ${skip.reason}`);
    lines.push('');
  }
  if (record.check !== undefined) {
    lines.push(
      '## The check',
      '',
      `\`${record.check.command}\` exited ${record.check.status}` +
        `${record.check.status === 0 ? ': every connection passed.' : ': see its output for each gap.'}`,
      '',
    );
  }
  return lines.join('\n');
}
