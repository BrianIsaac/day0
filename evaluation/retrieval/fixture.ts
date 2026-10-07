import { readFileSync } from 'node:fs';
import type { RequestSurface, SelectablePage } from '../../src/docs/select';

/*
 * The retrieval labelled set (wave 14, 14-R; the wave file's section 6.2): thirty work items an
 * employee of the company bed would be handed, each with the pages and the sections a person
 * would open to do it. The corpus is the bed's fifteen handbook pages (its folder's thirteen and
 * the two pasted Notion pages), the one rehearsal page that is not a copy of them (the Slack
 * app's own identity) and a Chinese runbook written for this set, which the bed walk adds to the
 * bed's folder. The rehearsal pages that repeat the bed's are left out: two copies of one page
 * would make "the page a person opens" two answers.
 */

/** A page of the corpus: where its Markdown is, its key and its category as the sync files it. */
interface CorpusPage {
  /** The file, from the repository root. */
  readonly file: string;
  readonly key: string;
  readonly title: string;
  readonly category: SelectablePage['category'];
}

/** The sources the corpus pages come from, as an owner would label them. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  company: 'Company handbook',
  notion: 'Notion',
  rehearsal: 'Rehearsal pages',
};

const CORPUS: readonly CorpusPage[] = [
  page('bed/company/folder/onboarding.md', 'company:onboarding.md', 'Kestrel Supply onboarding'),
  page(
    'bed/company/folder/revops/handbook.md',
    'company:revops/handbook.md',
    'Revenue operations handbook',
  ),
  guide(
    'bed/company/folder/revops/runbooks/how-to-post-slack.md',
    'company:revops/runbooks/how-to-post-slack.md',
    'How to post to Slack',
  ),
  guide(
    'bed/company/folder/revops/runbooks/how-to-refresh-the-tile.md',
    'company:revops/runbooks/how-to-refresh-the-tile.md',
    'How to refresh the Looker pipeline tile',
  ),
  guide(
    'bed/company/folder/revops/runbooks/how-to-update-ticket.md',
    'company:revops/runbooks/how-to-update-ticket.md',
    'How to update a Linear ticket',
  ),
  guide(
    'bed/company/folder/revops/runbooks/q3-close-checklist.md',
    'company:revops/runbooks/q3-close-checklist.md',
    'Q3 close checklist',
  ),
  page(
    'bed/company/folder/finance/handbook.md',
    'company:finance/handbook.md',
    'Finance close handbook',
  ),
  guide(
    'bed/company/folder/finance/runbooks/close-status-note.md',
    'company:finance/runbooks/close-status-note.md',
    'How to write the close status note',
  ),
  page(
    'bed/company/folder/logistics/handbook.md',
    'company:logistics/handbook.md',
    'Logistics desk handbook',
  ),
  guide(
    'bed/company/folder/logistics/runbooks/exception-note.md',
    'company:logistics/runbooks/exception-note.md',
    'How to record a shipment exception',
  ),
  page(
    'bed/company/folder/systems/looker-pipeline-tile.md',
    'company:systems/looker-pipeline-tile.md',
    'Looker pipeline tile',
  ),
  page('bed/company/folder/systems/netledger.md', 'company:systems/netledger.md', 'NetLedger'),
  page(
    'bed/company/folder/systems/northstar-crm.md',
    'company:systems/northstar-crm.md',
    'Northstar CRM',
  ),
  page(
    'bed/company/notion/linear-automation.md',
    'notion:linear-automation.md',
    'Linear automation',
  ),
  page(
    'bed/company/notion/slack-automation-policy.md',
    'notion:slack-automation-policy.md',
    'Slack automation policy',
  ),
  page(
    'tests/fixtures/notion-pages/slack-day0-app.md',
    'rehearsal:slack-day0-app.md',
    'Slack automation policy (an app per employee)',
  ),
  guide(
    'evaluation/retrieval/pages/warehouse-handover-zh.md',
    'company:logistics/runbooks/warehouse-handover-zh.md',
    '仓库交接流程',
  ),
];

function page(file: string, key: string, title: string): CorpusPage {
  return { file, key, title, category: 'team-doc' };
}

function guide(file: string, key: string, title: string): CorpusPage {
  return { file, key, title, category: 'how-to-guide' };
}

/** The repository root, which every corpus file is read from. */
const ROOT = new URL('../../', import.meta.url);

/**
 * The corpus as the selector reads it: each page's Markdown from the tree, keyed and cited as
 * the bed's sources would be.
 */
export function retrievalPages(): SelectablePage[] {
  return CORPUS.map((entry): SelectablePage => {
    const [source, ref] = entry.key.split(/:(.*)/s);
    return {
      key: entry.key,
      slug: `source-${ref.replace(/[^a-z0-9]+/gi, '-')}`,
      title: entry.title,
      category: entry.category,
      body: readFileSync(new URL(entry.file, ROOT), 'utf8'),
      citeSource: SOURCE_LABELS[source],
      citePage: ref,
    };
  });
}

/** The company bed's surfaces, as the employees reach them. */
export const RETRIEVAL_SURFACES: readonly RequestSurface[] = [
  { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp' },
  { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api' },
  {
    slug: 'looker-pipeline-tile',
    displayName: 'Looker pipeline tile',
    class: 'analytics',
    path: 'browser-driven',
  },
];

/** The three employees' functions, as their charters word them. */
export const RETRIEVAL_ROLES = {
  revops: 'Revenue operations coordination for the Q3 close',
  finance: 'Finance close reporting for the month-end close',
  logistics: 'Logistics desk shipment exception handling',
} as const;

/** A section a person would open: a page, and the last heading of the section on it. */
export interface LabelledSection {
  readonly page: string;
  readonly heading: string;
}

/** One labelled item: what the employee is handed, and what a person would open to do it. */
export interface RetrievalCase {
  readonly id: string;
  readonly role: keyof typeof RETRIEVAL_ROLES;
  readonly sourceSystem: 'linear' | 'slack';
  readonly title: string;
  readonly summary: string;
  readonly requester?: string;
  /** The pages a person would open, by key. */
  readonly pages: readonly string[];
  /** The sections a person would read on them. */
  readonly sections: readonly LabelledSection[];
}

const FIN_HANDBOOK = 'company:finance/handbook.md';
const STATUS_NOTE = 'company:finance/runbooks/close-status-note.md';
const LOG_HANDBOOK = 'company:logistics/handbook.md';
const EXCEPTION_NOTE = 'company:logistics/runbooks/exception-note.md';
const REVOPS_HANDBOOK = 'company:revops/handbook.md';
const POST_SLACK = 'company:revops/runbooks/how-to-post-slack.md';
const REFRESH_TILE = 'company:revops/runbooks/how-to-refresh-the-tile.md';
const UPDATE_TICKET = 'company:revops/runbooks/how-to-update-ticket.md';
const CHECKLIST = 'company:revops/runbooks/q3-close-checklist.md';
const TILE = 'company:systems/looker-pipeline-tile.md';
const NETLEDGER = 'company:systems/netledger.md';
const NORTHSTAR = 'company:systems/northstar-crm.md';
const ONBOARDING = 'company:onboarding.md';
const LINEAR = 'notion:linear-automation.md';
const SLACK_POLICY = 'notion:slack-automation-policy.md';
const SLACK_APP = 'rehearsal:slack-day0-app.md';
const HANDOVER_ZH = 'company:logistics/runbooks/warehouse-handover-zh.md';

/** The thirty labelled items. */
export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  {
    id: 'fin-status-note',
    role: 'finance',
    sourceSystem: 'linear',
    title: 'Post the September close status note',
    summary: 'Write the close status note on the status ticket from the step tickets.',
    pages: [STATUS_NOTE, FIN_HANDBOOK],
    sections: [
      { page: STATUS_NOTE, heading: 'Format' },
      { page: STATUS_NOTE, heading: 'Rules' },
    ],
  },
  {
    id: 'fin-where-close-stands',
    role: 'finance',
    sourceSystem: 'slack',
    title: 'Where does the September close stand?',
    summary: 'Asked in #finance-close: is the bank reconciliation done yet?',
    requester: 'Mei Lin',
    pages: [STATUS_NOTE, FIN_HANDBOOK],
    sections: [
      { page: STATUS_NOTE, heading: 'Rules' },
      { page: FIN_HANDBOOK, heading: 'How the team works' },
    ],
  },
  {
    id: 'fin-accrual-owner',
    role: 'finance',
    sourceSystem: 'linear',
    title: 'Confirm who owns the September accrual journal in NetLedger',
    summary: 'The accruals booked step needs the owner of the journal confirmed in the ledger.',
    pages: [NETLEDGER, FIN_HANDBOOK],
    sections: [
      { page: NETLEDGER, heading: 'NetLedger' },
      { page: FIN_HANDBOOK, heading: 'How the team works' },
    ],
  },
  {
    id: 'fin-accruals-late',
    role: 'finance',
    sourceSystem: 'slack',
    title: 'Accruals booked for September looks late',
    summary: 'Is the accruals step past its business day on the close calendar?',
    pages: [FIN_HANDBOOK, STATUS_NOTE],
    sections: [{ page: FIN_HANDBOOK, heading: 'The close calendar' }],
  },
  {
    id: 'fin-flash-report',
    role: 'finance',
    sourceSystem: 'linear',
    title: 'Book the flash report figures in NetLedger',
    summary: 'The controller asks for the flash report to be entered in the ledger.',
    pages: [NETLEDGER, FIN_HANDBOOK],
    sections: [
      { page: NETLEDGER, heading: 'NetLedger' },
      { page: FIN_HANDBOOK, heading: 'The close calendar' },
    ],
  },
  {
    id: 'log-held-no-eta',
    role: 'logistics',
    sourceSystem: 'linear',
    title: 'SH-2041 held at Port Klang, carrier has given no revised ETA',
    summary: 'Record the shipment exception and the customer notice on the ticket.',
    pages: [EXCEPTION_NOTE, LOG_HANDBOOK],
    sections: [
      { page: EXCEPTION_NOTE, heading: 'Comment format' },
      { page: LOG_HANDBOOK, heading: 'Notices and ETAs' },
    ],
  },
  {
    id: 'log-thread-reply',
    role: 'logistics',
    sourceSystem: 'slack',
    title: 'Shipment SH-2077 late, raised in #logistics-desk',
    summary: 'The warehouse says the pallet missed the carrier pickup; reply in the thread.',
    requester: 'Arif Hassan',
    pages: [EXCEPTION_NOTE, LOG_HANDBOOK],
    sections: [
      { page: EXCEPTION_NOTE, heading: 'Thread reply shape' },
      { page: LOG_HANDBOOK, heading: 'The exception process' },
    ],
  },
  {
    id: 'log-eta-confirmed',
    role: 'logistics',
    sourceSystem: 'linear',
    title: 'Customer notice for delayed shipment SH-3310, revised ETA confirmed',
    summary: 'The carrier confirmed a revised delivery date of 14 October.',
    pages: [LOG_HANDBOOK, EXCEPTION_NOTE],
    sections: [
      { page: LOG_HANDBOOK, heading: 'Customer notice templates' },
      { page: EXCEPTION_NOTE, heading: 'Comment format' },
    ],
  },
  {
    id: 'log-damaged-ops-request',
    role: 'logistics',
    sourceSystem: 'slack',
    title: 'Damaged pallet reported in #ops-requests',
    summary: 'A retailer reports a damaged pallet of shrink wrap on delivery.',
    pages: [LOG_HANDBOOK, ONBOARDING],
    sections: [
      { page: LOG_HANDBOOK, heading: 'The exception process' },
      { page: ONBOARDING, heading: 'Working rules for every team' },
    ],
  },
  {
    id: 'log-which-linear-team',
    role: 'logistics',
    sourceSystem: 'slack',
    title: 'Which Linear team and project hold the shipment exceptions?',
    summary: 'A new account manager asks where exception tickets live in Linear.',
    pages: [LINEAR, LOG_HANDBOOK],
    sections: [
      { page: LINEAR, heading: 'Where it is' },
      { page: LOG_HANDBOOK, heading: 'What the desk uses' },
    ],
  },
  {
    id: 'revops-refresh-tile',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Refresh the Looker pipeline tile to the approved figure',
    summary: 'The coverage figure on the tile should read 74% for the close.',
    pages: [REFRESH_TILE, TILE],
    sections: [
      { page: REFRESH_TILE, heading: 'Action shapes' },
      { page: TILE, heading: 'Current approved figure' },
    ],
  },
  {
    id: 'revops-stale-figure',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'The pipeline coverage figure on the dashboard is stale',
    summary: 'Asked in #revops-asks: the tile still shows last week’s coverage.',
    requester: 'Priya Raman',
    pages: [REFRESH_TILE, TILE],
    sections: [
      { page: REFRESH_TILE, heading: 'Action shapes' },
      { page: TILE, heading: 'Working rules' },
    ],
  },
  {
    id: 'revops-audit-note',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Write the Q3 close summary audit note',
    summary: 'Post the close-summary audit note with the evidence for each check.',
    pages: [CHECKLIST, UPDATE_TICKET],
    sections: [
      { page: CHECKLIST, heading: 'Writing the close-summary audit note' },
      { page: CHECKLIST, heading: 'The three checks' },
    ],
  },
  {
    id: 'revops-comment-close',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Comment on REVOPS-5 and move it to Done',
    summary: 'The summary is prepared; record it on the ticket and close the ticket.',
    pages: [UPDATE_TICKET, LINEAR],
    sections: [
      { page: UPDATE_TICKET, heading: 'Action shape' },
      { page: UPDATE_TICKET, heading: 'Closing the loop' },
    ],
  },
  {
    id: 'revops-reply-coverage-ask',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'What is the approved pipeline coverage figure for this close?',
    summary: 'Asked in #revops-asks; answer in the thread.',
    requester: 'Sam Ortiz',
    pages: [TILE, POST_SLACK],
    sections: [
      { page: TILE, heading: 'Current approved figure' },
      { page: POST_SLACK, heading: 'Closing the loop on a public-channel ask' },
    ],
  },
  {
    id: 'revops-globex-owner',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'Who owns the Globex opportunity in Northstar CRM?',
    summary: 'Sales asks for the opportunity owner and its forecast amount.',
    pages: [NORTHSTAR, REVOPS_HANDBOOK],
    sections: [
      { page: NORTHSTAR, heading: 'Northstar CRM' },
      { page: REVOPS_HANDBOOK, heading: 'Cold-start posture' },
    ],
  },
  {
    id: 'revops-rotate-linear-key',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Rotate the Linear service token for the automation',
    summary: 'The quarterly rotation of the company automation key is due.',
    pages: [LINEAR],
    sections: [{ page: LINEAR, heading: 'Access' }],
  },
  {
    id: 'revops-own-slack-app',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Register the new employee’s own Slack app from the manifest template',
    summary: 'Each automation should have its own Slack app and bot user.',
    pages: [SLACK_APP],
    sections: [
      { page: SLACK_APP, heading: 'How an automation gets its own Slack identity' },
      { page: SLACK_APP, heading: 'Manifest template' },
    ],
  },
  {
    id: 'revops-finance-channel',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'Which channel should a question about the month-end close go to?',
    summary: 'Asked in #ops-requests by a new starter.',
    pages: [SLACK_POLICY, FIN_HANDBOOK],
    sections: [{ page: SLACK_POLICY, heading: 'The channels, by team' }],
  },
  {
    id: 'revops-first-week',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'What should the new revenue operations employee read in its first week?',
    summary: 'The manager asks for the first-week reading plan.',
    pages: [REVOPS_HANDBOOK, ONBOARDING],
    sections: [{ page: REVOPS_HANDBOOK, heading: 'First week' }],
  },
  {
    id: 'revops-missing-slack-access',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'The employee has no Slack access yet',
    summary: 'Route the missing Slack access to the right administrator.',
    pages: [ONBOARDING, SLACK_POLICY],
    sections: [{ page: ONBOARDING, heading: 'Escalation' }],
  },
  {
    id: 'revops-standup-deals',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Reconcile the Friday standup deals in the Q4 pipeline tracker',
    summary: 'Check the three standup deals are in the tracker with stage and forecast amount.',
    pages: [CHECKLIST],
    sections: [{ page: CHECKLIST, heading: 'The three checks' }],
  },
  {
    id: 'revops-close-tickets-done',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Are all the Q3 close tickets at Done?',
    summary: 'Every Q3 close ticket except the audit-note ticket should be at Done.',
    pages: [CHECKLIST, UPDATE_TICKET],
    sections: [
      { page: CHECKLIST, heading: 'The three checks' },
      { page: UPDATE_TICKET, heading: 'Action shape' },
    ],
  },
  {
    id: 'revops-manager-dm-recap',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Send the manager the draft recap in the manager DM',
    summary: 'Draft first: the recap waits for the manager’s approval.',
    pages: [POST_SLACK, SLACK_POLICY],
    sections: [{ page: POST_SLACK, heading: 'Action shape' }],
  },
  {
    id: 'revops-tile-screenshot',
    role: 'revops',
    sourceSystem: 'slack',
    title: 'Attach a screenshot of the Looker tile to the ticket',
    summary: 'Sales wants a picture of the dashboard in REVOPS-6.',
    requester: 'Priya Raman',
    pages: [TILE, REFRESH_TILE],
    sections: [
      { page: TILE, heading: 'Working rules' },
      { page: REFRESH_TILE, heading: 'Discipline' },
    ],
  },
  {
    id: 'revops-tile-login-refused',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'The Looker tile refused the dashboard login',
    summary: 'The sign-in failed while refreshing the coverage figure.',
    pages: [TILE, REFRESH_TILE],
    sections: [
      { page: TILE, heading: 'Working rules' },
      { page: REFRESH_TILE, heading: 'Discipline' },
    ],
  },
  {
    id: 'revops-issue-status-change',
    role: 'revops',
    sourceSystem: 'linear',
    title: 'Move REVOPS-7 to In Progress with save_issue',
    summary: 'Which argument names the workflow state when the issue status changes?',
    pages: [UPDATE_TICKET, LINEAR],
    sections: [
      { page: UPDATE_TICKET, heading: 'Action shape' },
      { page: LINEAR, heading: 'Working rules' },
    ],
  },
  {
    id: 'zh-handover-signature',
    role: 'logistics',
    sourceSystem: 'slack',
    title: '夜班的交接清单缺少签字',
    summary: '仓库问：缺少签字的交接清单能不能交接给早班？',
    pages: [HANDOVER_ZH],
    sections: [{ page: HANDOVER_ZH, heading: '交接前检查' }],
  },
  {
    id: 'zh-handover-exception',
    role: 'logistics',
    sourceSystem: 'linear',
    title: '交接时发现破损货物',
    summary: '请按流程为破损货物开一张异常工单。',
    pages: [HANDOVER_ZH, EXCEPTION_NOTE],
    sections: [{ page: HANDOVER_ZH, heading: '记录异常' }],
  },
  {
    id: 'zh-handover-post',
    role: 'logistics',
    sourceSystem: 'slack',
    title: '发布本班次的交接结果',
    summary: '在频道里发布交接结果，包括货物数量。',
    pages: [HANDOVER_ZH],
    sections: [{ page: HANDOVER_ZH, heading: '发布交接结果' }],
  },
];
