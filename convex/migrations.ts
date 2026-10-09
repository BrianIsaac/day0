/**
 * The upgrade's migrations and the release stamp it compares (Q12, N10).
 *
 * A schema change that existing rows do not fit ships as two releases: the
 * first declares both shapes and runs a migration here, the second removes
 * the old declaration once every deployment has run it. Each migration reads
 * one bounded page per transaction and keeps its cursor in the `migrations`
 * table, so a deployment of any size migrates inside the transaction limits,
 * an interrupted run resumes where it stopped, and a finished migration is
 * never run again.
 *
 * The upgrade (`./setup.sh upgrade`, or any setup run over an existing
 * volume) pushes the functions, then runs
 *
 *   npx convex run migrations:runPending
 *
 * until nothing is pending, and only then stamps the release with
 * `migrations:recordRelease`, which refuses while a migration is unfinished.
 * The demo bed's `up` and the hosted deployment take the same two calls.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import {
  CREDENTIAL_RESEAL_MIGRATION,
  CREDENTIAL_VALUE_REF_MIGRATION,
  credentialKeyCounts,
  purgeCredential,
} from './credentials';
import { ORGANISATION_SECRET_HOLD_MS } from './organisationSecrets';
import {
  backfillAccessSetByPage,
  backfillWithheldToolsPage,
  newestConnectedEvent,
  restartAccessClocksPage,
} from './surfaces';
import { backfillUnavailableCausePage } from './work';
import { settleDecisionBatchesPage } from './decisionRequests';
import { keepTicketListing, WORK_LISTED_EVENT } from './ticketListings';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import { AGENT_RETIRED_EVENT } from './reset';
import { backfillLibraryPage, backfillOwnerKeyPage, backfillUseCountPage } from './skillVersions';
import { backfillMessagesTabPage } from './slackMessagesTab';
import { replacePageBlocks } from './docBlocks';
import { log } from '../src/lib/logger';
import { notTheirAddresses } from './peopleProposals';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { avatarById } from '../src/agent/avatar-pets';
import { mirroredDocSlug } from '../src/docs/types';
import { legacyUnreadRecord, reasonWithoutLegacyRecord } from '../src/docs/sync-record';
import { deploymentZone } from '../src/lib/zone';
import { compareReleases, NEWEST_MIGRATION_RELEASE, releaseParts } from '../src/lib/release';
import { actsAsAtUpgrade } from '../src/surfaces/access-identity';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';

/**
 * Every migration, in the order the upgrade runs them. The access clocks come
 * first, so the hourly sweep has the least time to end a card on the clock
 * they restart. A migration leaves this list when the declaration it cleared
 * is retired (`RETIRED_DECLARATIONS` in `scripts/releases.ts`), or the dual
 * read it served goes: `surfaces-kept-identity-since` (0.17.0) left at 0.18.0
 * with the kept-identity sweep's reason-word fallback (14-I). A deployment's
 * finished row of a migration that left stays as its record.
 */
export const MIGRATION_NAMES = [
  'surfaces-access-clock',
  'agents-owner',
  'credentials-sync-revoke',
  'ticket-listings',
  'agents-zone',
  'retirements-from-tombstones',
  'surfaces-approved-tools',
  'surfaces-access-set-by',
  'agents-avatar-digest',
  'mirrors-rekey',
  CREDENTIAL_RESEAL_MIGRATION,
  CREDENTIAL_VALUE_REF_MIGRATION,
  'surfaces-withheld-tools',
  'work-evaluation-unavailable-cause',
  'sync-runs-unread',
  'doc-page-listings',
  'credentials-superseded-at',
  'decision-batches-settled',
  'skills-library',
  'skills-use-count',
  'surfaces-acts-as',
  'credentials-issued-by',
  'skills-owner-key',
  'surfaces-intake-scope',
  'credentials-organisation-purge',
  'work-decision-closed',
  'surfaces-messages-tab',
  'docs-backfill-blocks',
  'people-not-their-addresses',
] as const;

/** One migration's name. */
export type MigrationName = (typeof MIGRATION_NAMES)[number];

/**
 * The migrations whose page runs in an action: the re-seal opens and seals
 * values, the ref rewrite opens and fingerprints them, and the intake scope
 * reads each card's pages as orientation reads them, which only the Node
 * runtime can do. Their pages are recorded by `recordActionPage`; every
 * other migration's page is one mutation.
 */
const ACTION_MIGRATION_NAMES = [
  CREDENTIAL_RESEAL_MIGRATION,
  CREDENTIAL_VALUE_REF_MIGRATION,
  'surfaces-intake-scope',
] as const;

/** A migration whose page runs in an action. */
type ActionMigrationName = (typeof ACTION_MIGRATION_NAMES)[number];

/** Whether a migration's page runs in an action rather than a mutation. */
function isActionMigration(name: MigrationName): name is ActionMigrationName {
  return (ACTION_MIGRATION_NAMES as readonly MigrationName[]).includes(name);
}

/** What a migration does, the release that ships it and what the next release may then remove. */
export interface MigrationDescription {
  readonly release: string;
  readonly does: string;
  /** The declaration or dual-read the release after `release` removes, once this has run everywhere. */
  readonly thenRemoves: string;
}

/** The release that ships the first set of migrations. */
const FIRST_MIGRATIONS_RELEASE = '0.4.0';

/** The release after it, which gives every agent a zone and a mode (N12, the M2 backfill). */
const ZONE_RELEASE = '0.5.0';

/**
 * The two schema steps after that, one release: retirements, the freeze's
 * approved list, the attempt count; then the card's own fields, the sync's
 * record and its listing stamp.
 */
const SCHEMA_STEP_RELEASE = '0.6.0';

/** The release of the owner's skill library (wave 10, 10-K): the library and the use count. */
const SKILL_LIBRARY_RELEASE = '0.13.0';

/**
 * The release of the access track (wave 11): whom each connected card acts as (11-AK), and how
 * Day0 obtained each credential an installed app gave it (11-AR).
 */
const ACCESS_RELEASE = '0.14.0';

/**
 * The schema step after the access track (the round after wave 11, R-S): the skill rows' owner
 * key, the intake scope of cards older than it, and the purge of organisation secrets kept past
 * their 24 hours.
 */
const ACCESS_FOLLOW_UP_RELEASE = '0.15.0';

/**
 * The release of the work loop and supervision (wave 12): the record of the decision close edits
 * claimed before the edit kept its result (12-W's N-3 lease). Its other pass, `sync-runs-refs`,
 * cleared the sync runs' page refs (12-S3, N10) and left this list with `docSyncRuns.refs` at
 * 0.17.0 (`RETIRED_DECLARATIONS`).
 */
const SUPERVISION_RELEASE = '0.16.0';

/**
 * The release of people and working agreements (wave 13): the schema step's marks on the cards
 * wave 12 recorded state for only in their reason words or the employee's record (13-K).
 */
const PEOPLE_RELEASE = '0.17.0';

/**
 * The release of retrieval (wave 14): the blocks the documentation search reads, split from every
 * page stored before it, and the people field wave 13 kept as evidence (14-I).
 */
const RETRIEVAL_RELEASE = '0.18.0';

/** Every migration's description, keyed by name. */
export const MIGRATIONS: Readonly<Record<MigrationName, MigrationDescription>> = {
  'agents-owner': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'gives an agent with no owner to the deployment’s one owner, when it has exactly one',
    thenRemoves: 'nothing: agents.userId stays optional until the customer profile keys owners',
  },
  'credentials-sync-revoke': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'clears the revokedAt a documentation sync stamped when it superseded a credential, so the value revives when it returns; a person’s revoke stays',
    thenRemoves: 'nothing: revokedAt is a person’s revoke from here on',
  },
  'ticket-listings': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'copies each kept work.listed snapshot into ticketListings, where the re-read before apply now looks',
    thenRemoves: 'nothing: work.listed events stay as the feed’s record',
  },
  'agents-zone': {
    release: ZONE_RELEASE,
    does: 'gives an agent with no zone the deployment’s current zone, and one with no mode the deployment’s mode; the status note names the zone',
    thenRemoves: 'nothing: an absent zone still reads as the deployment’s',
  },
  'retirements-from-tombstones': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies each retire tombstone an older release wrote as an agent.retired payload into the owner’s retirements table, where the export’s owner section now reads it',
    thenRemoves: 'nothing: the agent.retired events stay as the ledger’s record',
  },
  'surfaces-approved-tools': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies the tool list of each card that stores one into its approved list, which every later probe is frozen against and only the manager widens',
    thenRemoves: 'the fallback to toolAllowlist in surfaces.frozenTools',
  },
  'surfaces-access-set-by': {
    release: SCHEMA_STEP_RELEASE,
    does: 'records on each card with an access end date who set it, from its newest surface.access-set event, or the upgrade when it has none',
    thenRemoves: 'nothing: accessSetBy is written wherever the clock is set from here on',
  },
  'agents-avatar-digest': {
    release: SCHEMA_STEP_RELEASE,
    does: 'rewrites an avatar id the gallery no longer lists, the handle-keyed ids of earlier builds, to the face the dashboard already shows for it',
    thenRemoves: 'nothing: avatarById keeps its digest fallback for an id a client sends',
  },
  'mirrors-rekey': {
    release: SCHEMA_STEP_RELEASE,
    does: 'moves each documentation mirror an earlier slug rule keyed onto its own slug, and deletes it where a sync already wrote the page there',
    thenRemoves: 'nothing: finishSync keeps every mirror on its own slug from here on',
  },
  [CREDENTIAL_RESEAL_MIGRATION]: {
    release: SCHEMA_STEP_RELEASE,
    does: 're-seals every stored credential value bound to its owner under the current key and writes the key id; once it has finished, a row without a key id no longer opens unbound (Q15). A row the key cannot open is logged by id and left as it was, and counted as remaining',
    thenRemoves: 'the unbound open of a row without a key id in openOwnedCredential',
  },
  [CREDENTIAL_VALUE_REF_MIGRATION]: {
    release: SCHEMA_STEP_RELEASE,
    does: 'rewrites each documentation credential’s ref from the page alone, or its place and label on the page, to the page and a fingerprint of its value, so a relabelled or moved value keeps its credential and a swapped one is new; the row keeps its id and every surface bound to it. A row the key cannot open, or whose value another row of its page already holds, is logged by id, left as it was and counted as remaining',
    thenRemoves:
      'nothing: a sync moves a row still on an old ref by its value, as it does after a key rotation',
  },
  'surfaces-withheld-tools': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies onto each connected card the tools its newest surface.connected event withheld, less any the manager approved since, so the card reads them off the row',
    thenRemoves: 'nothing: recordConnected writes withheldTools from here on',
  },
  'work-evaluation-unavailable-cause': {
    release: SCHEMA_STEP_RELEASE,
    does: 'copies onto each row an evaluation found the scope judgement unreachable for the cause its newest work.scope-judgement-unavailable event gave, so the waiting line reads it off the row',
    thenRemoves: 'nothing: the cause is written with evaluationUnavailableAt from here on',
  },
  'sync-runs-unread': {
    release: SCHEMA_STEP_RELEASE,
    does: 'moves the record of unread pages each sync run kept as text below its reason onto the run’s unread field, leaving the reason the line it ended short on',
    thenRemoves:
      'the reading of a record in the reason text (legacyUnreadRecord in unreadRecordIn)',
  },
  'doc-page-listings': {
    release: SCHEMA_STEP_RELEASE,
    does: 'gives every stored documentation page a listing row stamped 0, older than any listing a sync starts, so the next finish that does not name the page removes it and one that does restamps it',
    thenRemoves:
      'the reading of docSyncRuns.refs as a pre-0.6.0 run’s listing (legacyListedRefs), once no run begun before this release can be resumed; the refs declaration the release after, with a migration clearing it (cleared by sync-runs-refs at 0.16.0, removed at 0.17.0)',
  },
  'decision-batches-settled': {
    release: SCHEMA_STEP_RELEASE,
    does: 'marks decided each batch whose members were all decided one at a time before the decide paths settled it, so the channel’s open-batch read holds only batches still waiting',
    thenRemoves: 'nothing: the decide paths settle a batch from here on',
  },
  'credentials-superseded-at': {
    release: SCHEMA_STEP_RELEASE,
    does: 'stamps each credential a sync superseded before this release with the upgrade, so its source’s finish prunes it once it has stayed superseded past the keep and no surface holds it',
    thenRemoves: 'nothing: a sync stamps supersededAt when it supersedes a row from here on',
  },
  'skills-library': {
    release: SKILL_LIBRARY_RELEASE,
    does: 'gives every registered agent-authored shaped skill of an owned employee a version in its owner’s skill library; its passing smoke test was not kept, so the version is not offerable and the skill is marked Re-check due (its check was not kept) until a re-check keeps one',
    thenRemoves: 'nothing: registration writes the version from here on',
  },
  'skills-use-count': {
    release: SKILL_LIBRARY_RELEASE,
    does: 'gives every skill the number of execution claims that named it and the time of the newest, from its employee’s work.execution-claimed events: the used-N-times count an older release did not keep; a count already larger is kept',
    thenRemoves: 'nothing: the execution claim counts each use from here on',
  },
  'surfaces-acts-as': {
    release: ACCESS_RELEASE,
    does: 'records whom each card holding a live credential acts as: its own app for an installed app’s token, named as the app, and a shared key for every pasted value or location, named as the key; a card with no credential, or a revoked or emptied one, is left for its next connection',
    thenRemoves:
      'nothing: each path that lands a credential is to write actsAs as wave 11’s connect units land; until one does, a card it connects carries none',
  },
  'credentials-issued-by': {
    release: ACCESS_RELEASE,
    does: 'records how Day0 obtained each live credential an installed Slack app gave it: the bot token from the install redirect, with the app it was issued to, and the client secret of the app the card provisioned; a pasted key, and a revoked or emptied row, are left',
    thenRemoves:
      'nothing: the Slack install path is to write issuedBy as 11-AS lands; until it does, a token installed after the upgrade is read as a pasted key and is not revoked at the vendor',
  },
  'skills-owner-key': {
    release: ACCESS_FOLLOW_UP_RELEASE,
    does: 'gives every skill row of an owned employee its owner’s key, which a version’s holders are now read by (K-m3); a row of an employee with no owner is left',
    thenRemoves:
      'nothing: every insert writes the key and a handover’s move rewrites it from here on',
  },
  'surfaces-intake-scope': {
    release: ACCESS_FOLLOW_UP_RELEASE,
    does: 'scopes each kanban card proposed before the approved intake scope as a proposal scopes it without its model: the documented team or project of the role’s handbook that the manager’s own words name, with a note saying so; a card the words do not scope keeps the page scan and says so on the card; mock mode reads nothing',
    thenRemoves:
      'nothing: the page scan stays for a card the pass could not scope, until its manager proposes it again',
  },
  'credentials-organisation-purge': {
    release: ACCESS_FOLLOW_UP_RELEASE,
    does: 'deletes the value of every organisation-held secret revoked more than 24 hours ago that still keeps it (an older revoke kept it, or its scheduled purge was lost), keeping the row and its revoke date; a row whose revocation at the vendor is still pending is left to its own sweep',
    thenRemoves: 'nothing: a revoke holds a secret 24 hours and schedules its purge from here on',
  },
  'work-decision-closed': {
    release: SUPERVISION_RELEASE,
    does: 'records every decided request’s close edit claimed before the edit kept its result as made, as the release that claimed it took it, so the sweep that releases a close claim lost before its result finds only claims made from this release; a claim with a result, an unclaimed close and a row with no request are left',
    thenRemoves: 'nothing: the close records its result from here on',
  },
  'surfaces-messages-tab': {
    release: PEOPLE_RELEASE,
    does: 'copies onto each chat card’s own app the open messages tab its employee’s record kept as surface.app-messages-open, newest line first, so the card’s reader can read it off the row once every writer writes it (13-FS); a card with no app of Day0’s, an app the record does not name and one whose state is already written are left; mock mode has no such app',
    thenRemoves:
      'nothing: typedCodeReachOf reads the card’s own field, which every writer of the opening writes (13-FS); the record’s lines stay as the record',
  },
  'docs-backfill-blocks': {
    release: RETRIEVAL_RELEASE,
    does: 'splits the stored, already redacted Markdown of every documentation page into the blocks the search index reads, under its source’s owner and the source’s last completed sync (its running one, or its newest, for a source that never completed); it asks nothing of the redaction component and changes no page; a page whose blocks already match is left, a page of a removed source is passed over, and mock mode stores no page',
    thenRemoves: 'nothing: every page a sync writes from this release is split as it is stored',
  },
  'people-not-their-addresses': {
    release: RETRIEVAL_RELEASE,
    does: 'copies every address a person’s evidence marks as someone else’s (the not-their-address: marker of W13-R8’s A different person) into the person’s notTheirAddresses, after any already there, keeping the evidence; a person with no marker is left, and mock mode stores no person',
    thenRemoves:
      'the marker evidence and its reader (notTheirAddresses in convex/peopleProposals.ts) the release after, once every writer writes the field and every reader reads it (14-FX)',
  },
  'surfaces-access-clock': {
    release: FIRST_MIGRATIONS_RELEASE,
    does: 'restarts an approved card’s access clock, which the old code started at proposal, at the default length from the upgrade',
    thenRemoves: 'nothing: the surface.access-set event it writes is the record',
  },
};

const migrationName = v.union(...MIGRATION_NAMES.map((name) => v.literal(name)));

/** The validator of an action migration's name. */
const actionMigrationName = v.union(...ACTION_MIGRATION_NAMES.map((name) => v.literal(name)));

/** Rows one page of a migration reads. */
const MIGRATION_PAGE = 100;

/**
 * Events one page of the listing copy reads. Event payloads are the largest
 * rows (a run's output rides on them), so the page is small enough that ten
 * documents at the 1 MiB document ceiling stay inside the 16 MiB read limit.
 * A byte bound on the page is not used: a page it cuts short may leave rows
 * unread, and a migration must not skip one.
 */
const EVENT_PAGE = 10;

/**
 * Sync runs one page of the unread-record move reads. A run of a release
 * before 0.6.0 listed up to 8,192 page refs until 0.16.0 cleared them, so ten
 * stayed well inside the transaction's read limit.
 */
const RUN_PAGE = 10;

/**
 * Rows one page of a migration over large rows reads: a documentation page or
 * its mirror carries a body of up to 768 KiB, and a work item its run's output
 * and plan, so the read is bounded by bytes as well
 * as rows (M23). A page the bound ends early continues from the last row it
 * returned, so no row is skipped.
 */
const LARGE_ROWS_READ = { numItems: MIGRATION_PAGE, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** How long one `runPending` call migrates before it hands back what is left. */
const RUN_BUDGET_MS = 8 * 60 * 1_000;

/** One page of one migration. */
interface MigrationPage {
  readonly read: number;
  readonly changed: number;
  readonly cursor: string;
  readonly isDone: boolean;
  /** What the migration chose where it had to choose, kept on its row. */
  readonly note?: string;
}

/** A migration as far as it has got. */
export interface MigrationProgress {
  readonly name: MigrationName;
  readonly release: string;
  readonly read: number;
  readonly changed: number;
  readonly completedAt?: number;
  /** What the migration chose where it had to choose. */
  readonly note?: string;
  /** Set when the migration had already finished before this call, so nothing ran. */
  readonly finishedEarlier?: true;
  /** Rows still to migrate, counted live, where the migration can say. */
  readonly remaining?: number;
  /** Set when `remaining` is a floor: the count stopped at its read bound. */
  readonly remainingAtLeast?: true;
}

/**
 * The owner every owned agent shares, or undefined when there are none or
 * more than one. Two reads of the owner index, first and last.
 */
async function soleOwner(ctx: QueryCtx): Promise<string | undefined> {
  const [first, last] = await Promise.all([
    ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.gt('userId', ''))
      .first(),
    ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.gt('userId', ''))
      .order('desc')
      .first(),
  ]);
  return first?.userId !== undefined && first.userId === last?.userId ? first.userId : undefined;
}

/**
 * Give ownerless agents to the deployment's one owner. An agent from before
 * owners existed is driven by the crons and reachable by nobody; on a
 * deployment with one owner it can only be theirs. With several owners it is
 * read and left, and the upgrade reports how many.
 */
async function adoptOwnerless(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const owner = await soleOwner(ctx);
  const page = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', undefined))
    .paginate({ cursor, numItems: MIGRATION_PAGE });
  if (owner !== undefined) {
    for (const agent of page.page) await ctx.db.patch(agent._id, { userId: owner });
  }
  return {
    read: page.page.length,
    changed: owner === undefined ? 0 : page.page.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Clear `revokedAt` where a documentation sync stamped it, not a person.
 *
 * Before 27 September the sync superseded a credential that left its page by
 * stamping `revokedAt` with the moment the run completed, and that stamp kept
 * the row dead when the value came back (U2 decision 1). Convex freezes
 * `Date.now()` inside a mutation, so the sync's stamp equals the superseding
 * run's `completedAt` exactly; a person's revoke, made in its own mutation,
 * carries a different moment and is left alone.
 */
async function clearSyncRevokes(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('credentials').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const credential of page.page) {
    const { revokedAt, source } = credential;
    if (credential.status !== 'superseded' || revokedAt === undefined) continue;
    if (typeof source === 'string') continue;
    const run = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source_completed_at', (q) =>
        q.eq('sourceId', source.sourceId).eq('completedAt', revokedAt),
      )
      .first();
    if (run?.state !== 'completed') continue;
    await ctx.db.patch(credential._id, { revokedAt: undefined });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** A kept listing's ticket, read field by field from an untyped event payload. */
function snapshotOf(value: unknown): TicketSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const tracker = value as Record<string, unknown>;
  if (typeof tracker.assigned !== 'boolean' || typeof tracker.doNotAutomate !== 'boolean') {
    return undefined;
  }
  const text = (field: string): string | undefined =>
    typeof tracker[field] === 'string' ? tracker[field] : undefined;
  return {
    assigned: tracker.assigned,
    doNotAutomate: tracker.doNotAutomate,
    ...(text('assigneeId') !== undefined ? { assigneeId: text('assigneeId') } : {}),
    ...(text('assigneeEmail') !== undefined ? { assigneeEmail: text('assigneeEmail') } : {}),
    ...(text('state') !== undefined ? { state: text('state') } : {}),
    ...(text('stateType') !== undefined ? { stateType: text('stateType') } : {}),
  };
}

/** Copy the listings kept as `work.listed` events into `ticketListings`. */
async function copyListings(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('events').paginate({ cursor, numItems: EVENT_PAGE });
  let changed = 0;
  for (const event of page.page) {
    if (event.type !== WORK_LISTED_EVENT) continue;
    const payload = event.payload as { workItemId?: unknown; tracker?: unknown; refused?: unknown };
    const tracker = snapshotOf(payload.tracker);
    const workItemId =
      typeof payload.workItemId === 'string'
        ? ctx.db.normalizeId('workItems', payload.workItemId)
        : null;
    if (tracker === undefined || workItemId === null) continue;
    const item = await ctx.db.get(workItemId);
    if (item === null) continue;
    const kept = await keepTicketListing(ctx, item, {
      tracker,
      refused: typeof payload.refused === 'string' ? payload.refused : undefined,
      listedAt: event.createdAt,
    });
    if (kept) changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Give every agent without one the deployment's zone and mode (N12's M2
 * backfill). The deployment's zone is the backend process's own, UTC on the
 * pinned image unless `TZ` is set; the manager changes it on the card.
 */
async function stampZoneAndMode(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const zone = deploymentZone();
  const page = await ctx.db.query('agents').paginate({ cursor, numItems: MIGRATION_PAGE });
  const missing = page.page.filter((agent) => agent.zone === undefined || agent.mode === undefined);
  for (const agent of missing) {
    await ctx.db.patch(agent._id, {
      ...(agent.zone === undefined ? { zone } : {}),
      ...(agent.mode === undefined ? { mode: SURFACE_MODE } : {}),
    });
  }
  return {
    read: page.page.length,
    changed: missing.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
    note: `agents with no zone given the deployment’s zone, ${zone}; with no mode, ${SURFACE_MODE}`,
  };
}

/**
 * Copy the retire tombstones older releases kept on `agent.retired` events
 * into `retirements`. A tombstone this release wrote names its row already
 * and is passed over; so is one without an owner, which no owner section
 * could list.
 */
async function copyRetirements(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db
    .query('events')
    .withIndex('by_type', (q) => q.eq('type', AGENT_RETIRED_EVENT))
    .paginate({ cursor, numItems: EVENT_PAGE });
  let changed = 0;
  for (const event of page.page) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.retirementId !== undefined || typeof payload.userId !== 'string') continue;
    const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
    const rowCounts = Object.fromEntries(
      Object.entries(
        typeof payload.rowCounts === 'object' && payload.rowCounts !== null
          ? (payload.rowCounts as Record<string, unknown>)
          : {},
      ).flatMap(([table, rows]) => (typeof rows === 'number' ? [[table, rows]] : [])),
    );
    await ctx.db.insert('retirements', {
      userId: payload.userId,
      agentId: event.agentId,
      retiredAt: typeof payload.retiredAt === 'number' ? payload.retiredAt : event.createdAt,
      rowCounts,
      revokedCredentials: count(payload.revokedCredentials),
      keptCredentials: count(payload.keptCredentials),
      claims: [],
      rejections: [],
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** Cards one page of the approved-list copy reads; a card with no list may walk its agent's events. */
const APPROVED_TOOLS_PAGE = 20;

/**
 * Give each card that stores a tool list an approved list of the same tools,
 * stamped at its last verification, so the freeze reads the approved list
 * whatever became of the stored one. A card the manager approved that holds
 * no list because a failed probe cleared it before the upgrade gets an empty
 * approved list, stamped at its newest connection, so the connection after
 * the upgrade withholds every tool until the manager approves them: the list
 * the manager saw is gone, and a re-probe never widens (wave 3.5 review M1).
 * A card that never connected is left to its first connection, which fixes
 * the list as it does for a card approved under this release. A card with an
 * approved list already is left alone.
 */
async function copyApprovedTools(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: APPROVED_TOOLS_PAGE });
  let changed = 0;
  for (const surface of page.page) {
    if (surface.approvedToolAllowlist !== undefined) continue;
    if (surface.toolAllowlist !== undefined) {
      await ctx.db.patch(surface._id, {
        approvedToolAllowlist: surface.toolAllowlist,
        toolAllowlistApprovedAt: surface.lastVerifiedAt ?? surface.createdAt,
      });
      changed += 1;
      continue;
    }
    if (surface.managerApprovedAt === undefined) continue;
    const connected = await newestConnectedEvent(ctx, surface);
    if (connected === undefined) continue;
    await ctx.db.patch(surface._id, {
      approvedToolAllowlist: [],
      toolAllowlistApprovedAt: connected.createdAt,
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Rewrite every stored avatar id the gallery does not list to the listed face
 * `avatarById` already shows for it (U15 D1 (a)): an earlier build keyed faces
 * by a person's handle (`tw-<handle>`), which an export would otherwise carry.
 */
async function rewriteAvatarIds(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('agents').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const agent of page.page) {
    if (agent.avatarId === undefined) continue;
    const listed = avatarById(agent.avatarId).id;
    if (listed === agent.avatarId) continue;
    await ctx.db.patch(agent._id, { avatarId: listed });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Put every documentation mirror on the slug `mirroredDocSlug` gives its page
 * (review M20). Before v0.5.0 a non-ASCII reference collapsed to its ASCII
 * part, so a sync under v0.5.0 wrote a second row beside the old one; the old
 * row is deleted where the new one exists, and moved onto the new slug where
 * no sync has written it yet, so the employee never loses the page.
 */
async function rekeyMirrors(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('mockDocs').paginate({ ...LARGE_ROWS_READ, cursor });
  let changed = 0;
  for (const mirror of page.page) {
    if (mirror.sourceId === undefined || mirror.sourceRef === undefined) continue;
    const slug = mirroredDocSlug(mirror.sourceId, mirror.sourceRef);
    if (mirror.slug === slug) continue;
    const current = await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', mirror.agentId).eq('slug', slug))
      .first();
    if (current) await ctx.db.delete(mirror._id);
    else await ctx.db.patch(mirror._id, { slug });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Move each sync run's record of its unread pages from the reason text a
 * release before 0.6.0 wrote it in onto the run's `unread` field (D D1 (a)),
 * so a rewrite of the reason can never lose it.
 */
async function moveUnreadRecords(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('docSyncRuns').paginate({ cursor, numItems: RUN_PAGE });
  let changed = 0;
  for (const run of page.page) {
    const record = run.unread === undefined ? legacyUnreadRecord(run.reason) : undefined;
    if (record === undefined) continue;
    await ctx.db.patch(run._id, { unread: record, reason: reasonWithoutLegacyRecord(run.reason) });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Record each decided request's close edit claimed before the close kept its result as made
 * (12-W's N-3 lease; 12-S3): until this release a claim was the only trace of the edit, which the
 * code then took as made, so no release ever sends it again. From this release the edit records
 * `closedAt` or `closeFailure`, and a claim with neither is one a lease may find. A row with either,
 * or with no claim, is left, so a second run changes nothing. A work item carries its run's output
 * and plan, so the page is bounded by bytes.
 */
async function recordClaimedCloses(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<MigrationPage> {
  const page = await ctx.db.query('workItems').paginate({ ...LARGE_ROWS_READ, cursor });
  let changed = 0;
  for (const row of page.page) {
    const decision = row.decision;
    if (
      decision?.closeClaimedAt === undefined ||
      decision.closedAt !== undefined ||
      decision.closeFailure !== undefined
    ) {
      continue;
    }
    await ctx.db.patch(row._id, { decision: { ...decision, closedAt: decision.closeClaimedAt } });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Give each stored documentation page a listing row (D D2 (a)). A page of a
 * release before 0.6.0 was kept by its run's refs; from this release a finish
 * removes a page whose row an earlier listing stamped, so every page needs
 * one. The stamp is 0, below every listing a sync starts: the next sync that
 * names the page restamps it, and a run begun before this release keeps the
 * pages its refs name.
 */
async function stampPageListings(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('docPages').paginate({ ...LARGE_ROWS_READ, cursor });
  let changed = 0;
  for (const stored of page.page) {
    const listed = await ctx.db
      .query('docPageListings')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', stored.sourceId).eq('ref', stored.ref))
      .first();
    if (listed !== null) continue;
    await ctx.db.insert('docPageListings', {
      sourceId: stored.sourceId,
      ref: stored.ref,
      seenBy: 0,
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Stamp each credential a sync superseded before 0.6.0 with the upgrade's
 * moment (C2 D2 (a)): when it was superseded is not recorded, so its keep
 * starts now, and no row is pruned sooner than the keep after the upgrade.
 */
async function stampSupersededAt(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const now = Date.now();
  const page = await ctx.db.query('credentials').paginate({ cursor, numItems: MIGRATION_PAGE });
  const unstamped = page.page.filter(
    (credential) => credential.status === 'superseded' && credential.supersededAt === undefined,
  );
  for (const credential of unstamped) await ctx.db.patch(credential._id, { supersededAt: now });
  return {
    read: page.page.length,
    changed: unstamped.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Record whom each card connected before the access track acts as (11-AK; the access plan,
 * section 4.2): `actsAsAtUpgrade` over the credential the card holds, read off the credential row
 * itself, since a card the older code attached may lack its copy of the kind. Only a live
 * credential names an identity: a card holding none, a revoked one, an emptied one or one deleted
 * under it is left for the connect path that next lands its credential. A card that already says
 * whom it acts as is left, so a second run changes nothing.
 */
async function backfillActsAs(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const surface of page.page) {
    if (surface.actsAs !== undefined || surface.credentialId === undefined) continue;
    const credential = await ctx.db.get(surface.credentialId);
    if (credential === null || credential.revokedAt !== undefined) continue;
    if (credential.ciphertext === undefined) continue;
    await ctx.db.patch(surface._id, { actsAs: actsAsAtUpgrade(surface, credential) });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** Whether a credential row is still live: not revoked, and still holding its value. */
function liveCredential(credential: Doc<'credentials'> | null): credential is Doc<'credentials'> {
  return (
    credential !== null && credential.revokedAt === undefined && credential.ciphertext !== undefined
  );
}

/**
 * Record how Day0 obtained each credential an installed Slack app gave it before the access track
 * (11-AR; 11-AK's cockpit item 4), so "only what Day0 obtained is revoked at the vendor" reads one
 * field: a card's bot token from the install redirect (`kind` and `source` both `oauth`, the only
 * redirect v0.13.0 had) is `oauth-install`, with the app it was issued to read off the card's
 * `provisioning` (else the row's own `appId`); the client secret `apps.manifest.create` returned
 * for the app the card provisioned is `app-created`. A pasted or documented key is never named,
 * and neither is a row whose access already ended (revoked or emptied). A row that already says
 * how it was obtained is left, so a second run changes nothing.
 */
async function backfillIssuedBy(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: MIGRATION_PAGE });
  let changed = 0;
  for (const surface of page.page) {
    const app = surface.provisioning;
    if (surface.credentialId !== undefined && surface.credentialKind === 'oauth') {
      const token = await ctx.db.get(surface.credentialId);
      if (
        liveCredential(token) &&
        token.issuedBy === undefined &&
        token.kind === 'oauth' &&
        token.source === 'oauth'
      ) {
        const appId = app?.appId ?? token.appId;
        await ctx.db.patch(token._id, {
          issuedBy: {
            system: 'slack',
            grant: 'oauth-install',
            ...(appId !== undefined ? { appId } : {}),
            ...(app !== undefined
              ? { clientId: app.clientId, clientSecretCredentialId: app.clientSecretCredentialId }
              : {}),
          },
        });
        changed += 1;
      }
    }
    if (app === undefined) continue;
    const secret = await ctx.db.get(app.clientSecretCredentialId);
    if (!liveCredential(secret) || secret.issuedBy !== undefined) continue;
    await ctx.db.patch(secret._id, {
      issuedBy: { system: 'slack', grant: 'app-created', appId: app.appId, clientId: app.clientId },
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * Delete the values of organisation-held secrets revoked more than 24 hours
 * ago that still keep them (F19; the pre-tag's cockpit item, the wave 11
 * review's M6): a revoke before v0.14.0 kept the ciphertext with no purge, and
 * a scheduled purge can be lost. The row and its revoke date stay as the
 * audit trail; a row whose revocation at the vendor is still pending is the
 * hourly sweep's (`sourceRevocation.expireOverdue`). A purged row keeps no
 * value, so a second run changes nothing.
 */
async function purgeExpiredOrganisationSecrets(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<MigrationPage> {
  const keptUntil = Date.now() - ORGANISATION_SECRET_HOLD_MS;
  const page = await ctx.db
    .query('credentials')
    .withIndex('by_userId', (q) => q.eq('userId', ORGANISATION_OWNER_KEY))
    .paginate({ cursor, numItems: MIGRATION_PAGE });
  const expired = page.page.filter(
    (row) =>
      row.holder === ORGANISATION_HOLDER &&
      row.revokedAt !== undefined &&
      row.revokedAt < keptUntil &&
      (row.ciphertext !== undefined || row.iv !== undefined) &&
      row.sourceRevocation?.state !== 'pending',
  );
  for (const row of expired) await purgeCredential(ctx, row, row.revokedAt ?? keptUntil);
  return {
    read: page.page.length,
    changed: expired.length,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Scope one page of cards intake reads by the page scan, in the Node runtime
 * (R-S; the wave 11 review's m5). The action writes each card itself; this
 * reports the page.
 */
async function scopeIntakeCards(ctx: ActionCtx, cursor: string | null): Promise<MigrationPage> {
  return await ctx.runAction(internal.intakeScopeBackfillActions.backfillPage, { cursor });
}

/**
 * Re-seal one page of credentials in the Node runtime (decision Q15, step
 * 14). The action writes each page's rows itself; this reports the page.
 */
async function resealCredentials(ctx: ActionCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.runAction(internal.credentialCryptoActions.resealPage, { cursor });
  return {
    read: page.read,
    changed: page.changed,
    cursor: page.cursor,
    isDone: page.isDone,
    ...(page.keyId !== undefined
      ? {
          note: `values re-sealed bound to their owners under key ${page.keyId}; a row the key could not open was logged by id and left as it was`,
        }
      : {}),
  };
}

/**
 * Rewrite one page of documentation credentials to value-keyed refs in the
 * Node runtime. The action writes each page's rows itself; this reports the
 * page.
 */
async function rewriteValueRefs(ctx: ActionCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.runAction(internal.credentialCryptoActions.valueRefPage, { cursor });
  return {
    read: page.read,
    changed: page.changed,
    cursor: page.cursor,
    isDone: page.isDone,
  };
}

/** Each action migration's page, keyed by name. */
const ACTION_MIGRATION_PAGES: Readonly<
  Record<ActionMigrationName, (ctx: ActionCtx, cursor: string | null) => Promise<MigrationPage>>
> = {
  [CREDENTIAL_RESEAL_MIGRATION]: resealCredentials,
  [CREDENTIAL_VALUE_REF_MIGRATION]: rewriteValueRefs,
  'surfaces-intake-scope': scopeIntakeCards,
};

/** Each mutation migration's page, keyed by name, so a name with no page fails the typecheck. */
const MIGRATION_PAGES: Readonly<
  Record<
    Exclude<MigrationName, ActionMigrationName>,
    (ctx: MutationCtx, cursor: string | null) => Promise<MigrationPage>
  >
> = {
  'agents-owner': adoptOwnerless,
  'credentials-sync-revoke': clearSyncRevokes,
  'ticket-listings': copyListings,
  'agents-zone': stampZoneAndMode,
  'retirements-from-tombstones': copyRetirements,
  'surfaces-approved-tools': copyApprovedTools,
  'surfaces-access-set-by': async (ctx, cursor) => await backfillAccessSetByPage(ctx, cursor),
  'agents-avatar-digest': rewriteAvatarIds,
  'mirrors-rekey': rekeyMirrors,
  'surfaces-access-clock': async (ctx, cursor) =>
    await restartAccessClocksPage(ctx, cursor, Date.now()),
  'surfaces-withheld-tools': async (ctx, cursor) => await backfillWithheldToolsPage(ctx, cursor),
  'work-evaluation-unavailable-cause': async (ctx, cursor) =>
    await backfillUnavailableCausePage(ctx, cursor),
  'sync-runs-unread': moveUnreadRecords,
  'doc-page-listings': stampPageListings,
  'credentials-superseded-at': stampSupersededAt,
  'decision-batches-settled': async (ctx, cursor) => await settleDecisionBatchesPage(ctx, cursor),
  'skills-library': async (ctx, cursor) => await backfillLibraryPage(ctx, cursor),
  'skills-use-count': async (ctx, cursor) => await backfillUseCountPage(ctx, cursor),
  'surfaces-acts-as': backfillActsAs,
  'credentials-issued-by': backfillIssuedBy,
  'skills-owner-key': async (ctx, cursor) => await backfillOwnerKeyPage(ctx, cursor),
  'credentials-organisation-purge': purgeExpiredOrganisationSecrets,
  'work-decision-closed': recordClaimedCloses,
  'surfaces-messages-tab': async (ctx, cursor) => await backfillMessagesTabPage(ctx, cursor),
  'docs-backfill-blocks': backfillBlocks,
  'people-not-their-addresses': liftNotTheirAddresses,
};

/**
 * Stored pages one page of the block backfill reads: one, so a page of the pass writes one stored
 * page's blocks at most, which its bounded heading paths keep under a transaction's 16 MiB however
 * the page is cut (W14-R1: four pages a transaction let two pages of long nested headings write
 * past it, and the pass then failed on every call).
 */
const BLOCK_BACKFILL_READ = { numItems: 1, maximumBytesRead: 1024 * 1024 } as const;

/** The pages a pass-over note names before it counts the rest. */
const PASSED_OVER_NAMED = 10;

/**
 * The block backfill's note with one more page it could not split (W14-R1), read back from the
 * note it already holds: the count, then the first pages by ref.
 */
export function passedOverNote(previous: string | undefined, ref: string): string {
  const held = /^(\d+) pages? could not be split[^:]*: (.*?)(?: and \d+ more)?\.$/.exec(
    previous ?? '',
  );
  const count = (held === null ? 0 : Number(held[1])) + 1;
  const named = held === null ? [] : held[2].split(', ');
  const listed = named.length < PASSED_OVER_NAMED ? [...named, ref] : named;
  const more = count - listed.length;
  return `${count} ${count === 1 ? 'page' : 'pages'} could not be split into sections for the documentation search, so the search does not find ${count === 1 ? 'it' : 'them'}: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

/**
 * Pass over the stored page the block backfill stands at, which it could not split, and record it
 * in the pass's note (W14-R1). Internal; `runPending` calls it when that page's run fails twice, so
 * the pass goes on to the next page and the passes after it still run. The page keeps its
 * Markdown and is split again when a sync next stores it.
 */
export const passOverBlockPage = internalMutation({
  args: {},
  handler: async (ctx): Promise<MigrationProgress> => {
    const name = 'docs-backfill-blocks';
    const row = await migrationRow(ctx, name);
    if (row?.completedAt !== undefined) return { ...progressOf(name, row), finishedEarlier: true };
    const page = await ctx.db
      .query('docPages')
      .paginate({ ...BLOCK_BACKFILL_READ, cursor: row?.cursor ?? null });
    const [stored] = page.page;
    return await recordPage(ctx, name, row, {
      read: page.page.length,
      changed: 0,
      cursor: page.continueCursor,
      isDone: page.isDone,
      ...(stored === undefined ? {} : { note: passedOverNote(row?.note, stored.ref) }),
    });
  },
});

/** Whose blocks a source's pages are, and the run they are filed under; null for a gone source. */
async function blockOwnerOf(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
): Promise<{ userId: string; generation: Id<'docSyncRuns'> } | null> {
  const source = await ctx.db.get(sourceId);
  if (source === null) return null;
  const generation =
    source.lastCompletedSyncId ??
    source.activeSyncId ??
    (
      await ctx.db
        .query('docSyncRuns')
        .withIndex('by_source', (q) => q.eq('sourceId', sourceId))
        .order('desc')
        .first()
    )?._id;
  return generation === undefined ? null : { userId: source.userId, generation };
}

/**
 * One page of the block backfill (14-I): split each stored page's Markdown, as stored, into its
 * blocks. The Markdown was redacted when the sync stored it, so nothing is redacted again; a page
 * whose blocks already match changes nothing, so a second run changes nothing.
 */
async function backfillBlocks(ctx: MutationCtx, cursor: string | null): Promise<MigrationPage> {
  const page = await ctx.db.query('docPages').paginate({ ...BLOCK_BACKFILL_READ, cursor });
  const owners = new Map<Id<'docSources'>, Awaited<ReturnType<typeof blockOwnerOf>>>();
  let changed = 0;
  for (const stored of page.page) {
    if (!owners.has(stored.sourceId)) {
      owners.set(stored.sourceId, await blockOwnerOf(ctx, stored.sourceId));
    }
    const owner = owners.get(stored.sourceId);
    if (owner === null || owner === undefined) continue;
    const written = await replacePageBlocks(ctx, {
      ...owner,
      sourceId: stored.sourceId,
      pageRef: stored.ref,
      markdown: stored.markdown,
    });
    if (written > 0) changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/**
 * One page of the lift of W13-R8's marker (14-I): every address a person's evidence marks as
 * someone else's joins the person's `notTheirAddresses`, after those already there. The evidence
 * stays, so its card and every reader of the marker read as before until they read the field.
 */
async function liftNotTheirAddresses(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<MigrationPage> {
  const page = await ctx.db.query('people').paginate({ ...LARGE_ROWS_READ, cursor });
  let changed = 0;
  for (const person of page.page) {
    const held = person.notTheirAddresses ?? [];
    const lifted = [...notTheirAddresses(person)].filter((address) => !held.includes(address));
    if (lifted.length === 0) continue;
    await ctx.db.patch(person._id, { notTheirAddresses: [...held, ...lifted] });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** A migration's row, if it has started. */
async function migrationRow(ctx: QueryCtx, name: MigrationName): Promise<Doc<'migrations'> | null> {
  return await ctx.db
    .query('migrations')
    .withIndex('by_name', (q) => q.eq('name', name))
    .unique();
}

/** A migration's progress as the upgrade reports it. */
function progressOf(
  name: MigrationName,
  row: Pick<Doc<'migrations'>, 'read' | 'changed' | 'completedAt' | 'note'> | null,
): MigrationProgress {
  return {
    name,
    release: MIGRATIONS[name].release,
    read: row?.read ?? 0,
    changed: row?.changed ?? 0,
    ...(row?.completedAt !== undefined ? { completedAt: row.completedAt } : {}),
    ...(row?.note !== undefined ? { note: row.note } : {}),
  };
}

/**
 * Write where a page left a migration: its cursor, its counts, and its
 * completion when the page was the last.
 */
async function recordPage(
  ctx: MutationCtx,
  name: MigrationName,
  row: Doc<'migrations'> | null,
  page: MigrationPage,
): Promise<MigrationProgress> {
  const now = Date.now();
  const reached = {
    cursor: page.isDone ? undefined : page.cursor,
    read: (row?.read ?? 0) + page.read,
    changed: (row?.changed ?? 0) + page.changed,
    completedAt: page.isDone ? now : undefined,
    note: page.note ?? row?.note,
  };
  if (row === null) {
    await ctx.db.insert('migrations', {
      name,
      release: MIGRATIONS[name].release,
      startedAt: now,
      ...reached,
    });
  } else {
    await ctx.db.patch(row._id, reached);
  }
  return progressOf(name, reached);
}

/**
 * Run the next page of one mutation migration and record where it reached.
 * Internal; called by `runPending`. A finished migration reads nothing and
 * writes nothing.
 *
 * @throws Error for an action migration, whose page runs through `runPending`.
 */
export const runMigrationPage = internalMutation({
  args: { name: migrationName },
  handler: async (ctx, args): Promise<MigrationProgress> => {
    const { name } = args;
    const row = await migrationRow(ctx, name);
    if (row?.completedAt !== undefined) {
      return { ...progressOf(name, row), finishedEarlier: true };
    }
    if (isActionMigration(name)) {
      throw new Error(`${name} runs its pages in an action; run migrations:runPending`);
    }
    return await recordPage(ctx, name, row, await MIGRATION_PAGES[name](ctx, row?.cursor ?? null));
  },
});

/** Where a migration's next page starts, for an action migration's page. Internal. */
export const migrationStart = internalQuery({
  args: { name: actionMigrationName },
  handler: async (
    ctx,
    args,
  ): Promise<{ cursor: string | null; progress: MigrationProgress; finished: boolean }> => {
    const row = await migrationRow(ctx, args.name);
    return {
      cursor: row?.cursor ?? null,
      progress: progressOf(args.name, row),
      finished: row?.completedAt !== undefined,
    };
  },
});

/**
 * Record an action migration's page. Internal; called by `runPending`.
 *
 * Written only if the migration is still where the page started: a second
 * runner that got there first has recorded that page already, so this one's
 * counts are dropped rather than added twice, and its caller reads on from
 * the stored cursor.
 */
export const recordActionPage = internalMutation({
  args: {
    name: actionMigrationName,
    fromCursor: v.union(v.string(), v.null()),
    page: v.object({
      read: v.number(),
      changed: v.number(),
      cursor: v.string(),
      isDone: v.boolean(),
      note: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args): Promise<MigrationProgress> => {
    const row = await migrationRow(ctx, args.name);
    if (row?.completedAt !== undefined) {
      return { ...progressOf(args.name, row), finishedEarlier: true };
    }
    if ((row?.cursor ?? null) !== args.fromCursor) return progressOf(args.name, row);
    return await recordPage(ctx, args.name, row, args.page);
  },
});

/**
 * Run the next page of one migration, in whichever runtime its page needs,
 * and record where it reached.
 */
async function runNextPage(ctx: ActionCtx, name: MigrationName): Promise<MigrationProgress> {
  if (name === 'docs-backfill-blocks') return await runBlockBackfillPage(ctx);
  if (!isActionMigration(name)) {
    return await ctx.runMutation(internal.migrations.runMigrationPage, { name });
  }
  const start = await ctx.runQuery(internal.migrations.migrationStart, { name });
  if (start.finished) return { ...start.progress, finishedEarlier: true };
  const page = await ACTION_MIGRATION_PAGES[name](ctx, start.cursor);
  return await ctx.runMutation(internal.migrations.recordActionPage, {
    name,
    fromCursor: start.cursor,
    page,
  });
}

/**
 * Run the block backfill's next page, tried twice; a page that fails both is passed over and named
 * in the pass's note (W14-R1), so one page the backend will not write never stops the upgrade.
 */
async function runBlockBackfillPage(ctx: ActionCtx): Promise<MigrationProgress> {
  const name = 'docs-backfill-blocks';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await ctx.runMutation(internal.migrations.runMigrationPage, { name });
    } catch (error) {
      // Each failure is logged with its reason, so a fault that is not the page's own (a bug, a
      // backend restart) is seen in the log beside the page it passed over.
      log.warn('migration page failed', {
        migration: name,
        attempt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return await ctx.runMutation(internal.migrations.passOverBlockPage, {});
}

/**
 * Run every unfinished migration to the end, in order, and say what each
 * one this call ran changed; a migration finished by an earlier call is not
 * reported again. Internal; the upgrade calls it through `npx convex run`. A call
 * that reaches its time budget returns with the rest still pending, and the
 * next call carries on from the stored cursor.
 */
export const runPending = internalAction({
  args: {},
  handler: async (ctx): Promise<{ migrations: MigrationProgress[]; pending: MigrationName[] }> => {
    const startedAt = Date.now();
    const migrations: MigrationProgress[] = [];
    for (const [index, name] of MIGRATION_NAMES.entries()) {
      // One transaction per page, so no migration meets the per-transaction
      // read and write limits however many rows the deployment holds.
      let progress = await runNextPage(ctx, name);
      while (progress.completedAt === undefined) {
        if (Date.now() - startedAt > RUN_BUDGET_MS) {
          return { migrations, pending: MIGRATION_NAMES.slice(index) };
        }
        progress = await runNextPage(ctx, name);
      }
      if (progress.finishedEarlier !== true) migrations.push(progress);
    }
    return { migrations, pending: [] };
  },
});

/** The release stamp as the upgrade reads it. */
export interface ReleaseStamp {
  readonly release: string;
  readonly commit?: string;
  readonly recordedAt: number;
}

/** The newest release stamp, or null on a deployment that has none. */
async function latestRelease(ctx: QueryCtx): Promise<ReleaseStamp | null> {
  const row = await ctx.db.query('deploymentVersions').order('desc').first();
  if (row === null) return null;
  return {
    release: row.release,
    recordedAt: row.recordedAt,
    ...(row.commit !== undefined ? { commit: row.commit } : {}),
  };
}

/**
 * Every migration's progress and the release the rows are at. Internal;
 * `npx convex run migrations:status` prints it.
 */
export const status = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    release: ReleaseStamp | null;
    migrations: MigrationProgress[];
    pending: MigrationName[];
  }> => {
    const [counts, migrations] = await Promise.all([
      credentialKeyCounts(ctx),
      Promise.all(
        MIGRATION_NAMES.map(async (name) => progressOf(name, await migrationRow(ctx, name))),
      ),
    ]);
    return {
      release: await latestRelease(ctx),
      migrations: migrations.map((progress): MigrationProgress => {
        const remaining =
          progress.name === CREDENTIAL_RESEAL_MIGRATION
            ? counts.unkeyed
            : progress.name === CREDENTIAL_VALUE_REF_MIGRATION
              ? counts.legacyRefs
              : undefined;
        return remaining === undefined
          ? progress
          : {
              ...progress,
              remaining,
              ...(counts.atLeast ? { remainingAtLeast: true as const } : {}),
            };
      }),
      pending: migrations.flatMap((row) => (row.completedAt === undefined ? [row.name] : [])),
    };
  },
});

/**
 * Why a release may not be stamped, or undefined when it may: a stamp names
 * a release shaped as three numbers and no older than the newest one a
 * shipped migration names (`NEWEST_MIGRATION_RELEASE`, held equal to the
 * migrations' releases by the mirror test), so a deployment set up from a
 * tree whose package still names the release before its migrations never
 * reads as lacking them. The upgrade refuses such a tree before it pushes
 * (`scripts/releases.ts`); this is the check that holds when it did not run.
 */
function releaseRefusal(release: string): string | undefined {
  if (
    releaseParts(release) !== undefined &&
    compareReleases(release, NEWEST_MIGRATION_RELEASE) >= 0
  ) {
    return undefined;
  }
  return (
    `release ${release} cannot be stamped: a stamp names a release as X.Y.Z no older than ` +
    `${NEWEST_MIGRATION_RELEASE}, the newest release a shipped migration names`
  );
}

/**
 * Stamp the release the rows are now at. Internal; the upgrade calls it last.
 * Refused while any migration is unfinished, so a stamp always means every
 * row has the shape that release expects, and refused for a release older
 * than the newest one a shipped migration names. Stamping the release and
 * commit the deployment already carries writes nothing.
 *
 * @throws Error naming the unfinished migrations, or the release refused.
 */
export const recordRelease = internalMutation({
  args: { release: v.string(), commit: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ release: string; previous: string | null }> => {
    const unfinished: MigrationName[] = [];
    for (const name of MIGRATION_NAMES) {
      if ((await migrationRow(ctx, name))?.completedAt === undefined) unfinished.push(name);
    }
    if (unfinished.length > 0) {
      throw new Error(
        `migrations still to run (${unfinished.join(', ')}); run \`npx convex run migrations:runPending\` first`,
      );
    }
    const refusal = releaseRefusal(args.release);
    if (refusal !== undefined) throw new Error(refusal);
    const latest = await latestRelease(ctx);
    if (latest?.release !== args.release || latest.commit !== args.commit) {
      await ctx.db.insert('deploymentVersions', {
        release: args.release,
        recordedAt: Date.now(),
        ...(args.commit !== undefined ? { commit: args.commit } : {}),
      });
    }
    return { release: args.release, previous: latest?.release ?? null };
  },
});
