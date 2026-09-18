import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, WorkCandidate } from '../../../src/work/types';

/**
 * Aiko's LOG-2 from the full internal run of 19 September (main e86cc5d, real
 * mode, autonomy off): the work item, its approved plan, the one standing
 * read that grounded the plan and the phase-one response whose manager DM
 * the evidence check withheld for a sentence the ticket carries word for
 * word. Every string is the run's own, read from the export; only the
 * manager's DM channel id is replaced.
 */

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});

/** A manager DM as the run sent it, to the test's manager channel. */
export const managerDm = (text: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack', method: 'POST', path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}', 'Content-Type': 'application/json; charset=utf-8' }),
    body: JSON.stringify({ channel: 'D0MANAGER', text }),
  },
});

/** The sentence the check refused twice, which is LOG-2's own description. */
export const LOG_2_REFUSED_CLAIM = 'Meridian Freight has confirmed a revised delivery date of 26 September.';

export const log2Candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'LOG-2',
  title: "Exception: SH-4460 delivered one day late, ETA confirmed",
  contentSummary: "Shipment SH-4460 will be delivered one day late. The carrier, Meridian Freight, has confirmed a revised delivery date of 26 September.\n\nday0-demo-key: log-sh4460",
  contentRefs: ["https://linear.app/day00/issue/LOG-2/exception-sh-4460-delivered-one-day-late-eta-confirmed"],
  observedAt: new Date(1789757834255),
  requesterLabel: "Brian",
};

export const log2Plan: ExecutionPlan = {
  "summary": "LOG-2 records a one-day delay on SH-4460 with a carrier-confirmed revised ETA of 26 September, so the handbook's 'Delay, revised ETA confirmed' template applies with no open questions. Per the logistics desk process I will draft the notice, send the draft to the manager DM for approval, record the exception as one comment on LOG-2, and then move the ticket to Done. All writes are held for the manager's literal approval while autonomous actions are off.",
  "steps": [
    "Draft the customer notice from the handbook template 'Delay, revised ETA confirmed' with SH-4460, Meridian Freight and 26 September filled in, and assemble the full exception comment in the documented format.",
    "Send the draft notice and comment text to the manager DM for approval before anything is published (held for the manager's literal approval).",
    "After manager approval, post the exception comment on LOG-2 via linear save_comment (held for approval).",
    "After the comment is posted, move LOG-2 to Done via linear save_issue (held for approval)."
  ],
  "expectedOutputType": "ticket-update",
  "riskNotes": "The notice text itself is never sent to the customer by me — the account team sends it from the ticket — so the manager DM carries the draft for review only. All Linear writes and the Slack DM are held for the manager's literal approval while autonomous actions are off.",
  "reversibility": "The Linear comment and status change are editable/reversible in Linear; the manager DM is informational only. No customer-facing message is sent by this plan.",
  "estimatedMinutes": 15,
  "obligations": {
    "basis": "judgement",
    "plannerTransition": "promised",
    "reason": "The plan moves LOG-2 to Done only after the manager approves the draft, so the state change is conditional on manager approval.",
    "steps": [
      {
        "kind": "report",
        "reads": [],
        "reason": "Assembles the notice text and comment draft in the response from the handbook template already given; touches no surface.",
        "writes": []
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Sends the draft notice and comment text to the manager DM via chat.postMessage for approval before anything is published.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Posts the exception comment on LOG-2 via save_comment only after the manager approves the draft.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Moves LOG-2 to Done via save_issue only after the comment is posted and manager approval is in hand.",
        "writes": [
          "linear"
        ]
      }
    ],
    "transition": "conditional-on-manager",
    "transitionStep": 4
  }
};

/** The plan-grounding read as its event stored it: `get_issue` on LOG-2 under standing authority, already redacted. */
export const log2GroundingAction: MockAction = call('linear', 'get_issue', { id: 'LOG-2' });
export const log2GroundingApplied: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  authority: 'standing',
  providerId: 'LOG-2',
  idempotencyKey: "nh797a523dh17a6nzsbcg9bcrn8en41v:k971zey9ac08hsg0369nyvkatd8emf68:0",
  effect: "get_issue on linear · {\"id\":\"LOG-2\",\"uuid\":\"bb9a54f4-a988-43c0-a942-2b67ecfae17c\",\"title\":\"Exception: SH-4460 delivered one day late, ETA confirmed\",\"description\":\"Shipment SH-4460 will be delivered one day late. The carrier, Meridian Freight, has confirmed a revised delivery date of 26 September.\n\nday0-demo-key: <redacted>\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/LOG-2/exception-sh-4460-delivered-one-day-late-eta-confirmed\",\"gitBranchName\":\"<redacted>\",\"createdAt\":\"2026-09-18T18:25:30.691Z\",\"updatedAt\":\"2026-09-18T18:25:30.691Z\",\"archivedAt\":null,\"completedAt\":null,\"startedAt\":null,\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"Todo\",\"statusType\":\"unstarted\",\"labels\":[\"day0-demo\"],\"attachments\":[],\"documents\":[],\"stateHistory\":[{\"state\":{\"id\":\"e1c5a4e5-3343-4856-942a-71bd43bc02f6\",\"name\":\"Todo\",\"type\":\"unstarted\"},\"startedAt\":\"2026-09-18T18:25:30.691Z\",\"endedAt\":null}],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"Shipment exceptions\",\"projectId\":\"12037718-465c-4c21-a72f-2ff53d031816\",\"team\":\"Logistics desk\",\"teamId\":\"ed6a86e1-fa34-4ae2-abd0-9a83dba58f41\"}",
};

/** The manager DM the check withheld, as the executor wrote it. */
export const LOG_2_DRAFT_DM = "Draft for your approval — LOG-2 (SH-4460, one day late, Meridian Freight, revised ETA 26 September). Source: candidate from Brian on LOG-2, which states 'The carrier, Meridian Freight, has confirmed a revised delivery date of 26 September.'\n\nCustomer notice (template 'Delay, revised ETA confirmed'):\n\"Your shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\"\n\nException comment for LOG-2:\nException: SH-4460, delivered one day late, delivery address (not stated on the ticket)\nCarrier: Meridian Freight; revised ETA: 26 September\nCustomer notice (Delay, revised ETA confirmed):\nYour shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\nNext update: none\n\nOn your approval I will post this comment on LOG-2 and then move LOG-2 to Done. No customer notice is sent by me; the account team sends it from the ticket.";

const LOG_2_COMMENT = "Exception: SH-4460, delivered one day late, delivery address (not stated on the ticket)\nCarrier: Meridian Freight; revised ETA: 26 September\nCustomer notice (Delay, revised ETA confirmed):\nYour shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\nNext update: none";

/** Phase one as the model returned it: the read, the DM, the held comment and the held Done. */
export const log2PhaseOneActions: MockAction[] = [
  call('linear', 'get_issue', { id: 'LOG-2' }),
  managerDm(LOG_2_DRAFT_DM),
  call('linear', 'save_comment', { issueId: 'LOG-2', body: LOG_2_COMMENT }),
  call('linear', 'save_issue', { id: 'LOG-2', state: 'Done' }),
];

export const LOG_2_DRAFT = "Exception LOG-2 (SH-4460, delivered one day late, carrier Meridian Freight, revised ETA confirmed 26 September).\n\nPlanned customer notice — handbook template 'Delay, revised ETA confirmed' (logistics desk handbook), every placeholder filled:\n\n\"Your shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\"\n\nPlanned exception comment on LOG-2, in the documented format (How to record a shipment exception):\n\nException: SH-4460, delivered one day late, delivery address (not stated on the ticket)\nCarrier: Meridian Freight; revised ETA: 26 September\nCustomer notice (Delay, revised ETA confirmed):\nYour shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\nNext update: none\n\nSequence: the draft above goes to you for approval first; after your approval the comment is posted on LOG-2 via linear save_comment, then LOG-2 moves to Done via linear save_issue. Both writes are held for your literal approval while autonomous actions are off. No customer notice is sent by me — the account team sends it from the ticket.";
