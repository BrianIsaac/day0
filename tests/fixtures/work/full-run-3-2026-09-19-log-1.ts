import type { AppliedAction } from '../../../src/surfaces/types';
import type { GroundingRead } from '../../../src/work/evidence-claims';
import type { ExecutionPlan, LandedWrite, MockAction, RefusedClosing, WorkCandidate } from '../../../src/work/types';

/**
 * Aiko's LOG-1 (SH-4471) and Mateo's FIN-1 from the third full internal run
 * of 19 September (main dbdc8aa, real mode, autonomy off): the work items,
 * their approved plans with the declared obligations, the standing read that
 * grounded LOG-1's plan, the manager's retry notes, and the closing sets the
 * promised-read gate refused. Every string is the run's own, read from the
 * rows in the run's findings and its export; only the manager's DM channel
 * id is replaced and `observedAt` is rebuilt as a date.
 */

/** The gate's sentence on all three LOG-1 refusals. */
export const LOG_1_REFUSAL = "approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded";

export const log1Candidate: WorkCandidate = { ...{
  "sourceCategory": "ticket-queue",
  "sourceSystem": "linear",
  "externalId": "LOG-1",
  "title": "Exception: SH-4471 held at Port Klang, Meridian Freight, no revised ETA",
  "contentSummary": "Shipment SH-4471 is held at Port Klang. The carrier, Meridian Freight, has not given a revised ETA.\n\nday0-demo-key: log-sh4471",
  "contentRefs": [
    "https://linear.app/day00/issue/LOG-1/exception-sh-4471-held-at-port-klang-meridian-freight-no-revised-eta"
  ],
  "requesterLabel": "Brian"
}, observedAt: new Date(1789774818301) } as WorkCandidate;

export const log1Plan = {
  "estimatedMinutes": 15,
  "expectedOutputType": "ticket-update",
  "obligations": {
    "basis": "judgement",
    "plannerTransition": "conditional-on-manager",
    "reason": "The plan moves LOG-1 to Done only after the exception comment is confirmed posted on the ticket, so the state change is conditional on that evidence.",
    "steps": [
      {
        "kind": "read",
        "reads": [
          "linear"
        ],
        "reason": "Read LOG-1 from Linear to confirm the shipment, location, carrier and that no revised ETA was given.",
        "writes": []
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Escalate to the manager in DM asking which template to use and the next-update time, since the carrier gave no ETA.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Post the exception comment on LOG-1 only once the manager's template choice and next-update time arrive, with every placeholder filled.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Move LOG-1 to Done only after the exception comment has posted, keeping the comment as the prior audit trace.",
        "writes": [
          "linear"
        ]
      }
    ],
    "transition": "conditional-on-evidence",
    "transitionStep": 4
  },
  "reversibility": "Low risk: the only surface changes are one Linear comment and one status change on LOG-1, both reversible in Linear and both gated on manager approval. The manager DM is read-only outreach.",
  "riskNotes": "The customer notice cannot be completed from the ticket alone: the handbook requires the desk lead to choose the template and set the next-update time when no ETA exists. That answer is a manager decision at approval time; steps 3-4 wait on it. The comment format also requires a template name 'word for word' from the handbook, which depends on the manager's choice. No Slack thread reply is planned since the exception arrived via Linear, not #logistics-desk.",
  "steps": [
    "Read LOG-1 in Linear (already ingested via get_issue) and confirm the exception details: shipment SH-4471, held at Port Klang, carrier Meridian Freight, revised ETA: none given.",
    "Send the manager a DM (via the slack surface, manager DM) escalating per the handbook: SH-4471 has no revised ETA, so ask which of the two handbook templates to use ('Delay, ETA unconfirmed, next update by <time>' is the likely fit) and what next-update time to promise. This DM is a question/escalation, which the manager DM is for.",
    "Once the manager answers, draft the exception comment in the 'How to record a shipment exception' format with every placeholder filled from the ticket and the manager's answer, and emit save_comment on LOG-1 — held for the manager's literal approval before it posts.",
    "After the comment posts, emit save_issue to move LOG-1 to Done — held for the manager's approval; per the runbook the comment precedes any status change."
  ],
  "summary": "LOG-1 records shipment SH-4471 held at Port Klang with Meridian Freight and no revised ETA. The handbook says: when the carrier has given no ETA, ask the desk lead which template to use before writing the customer notice, and the desk lead sets the next-update time. So the notice text cannot be filled yet; the plan is to escalate to the manager for the template choice and next-update time, then record the exception comment and close the ticket once the answer lands. All writes are held for the manager's literal approval since autonomous actions are off."
} as ExecutionPlan;

/** The note the manager gave with Retry, twice: the logistics correction from the company bed's answers. */
export const LOG_1_RETRY_NOTE = "For a Meridian Freight hold at Port Klang with no revised ETA, use the \"Delay, ETA unconfirmed, next update by <time>\" template, with the next update by 17:00 SGT the next business day.";

/** The `work.plan-grounding-read` event's payload: `get_issue` on LOG-1 under standing authority, before the plan was drafted. */
export const log1GroundingRead = {
  "action": {
    "args": {
      "surface": "linear",
      "tool": "get_issue",
      "toolArgsJson": "{\"id\":\"LOG-1\"}"
    },
    "tool": "mcp.call"
  },
  "applied": {
    "authority": "standing",
    "effect": "get_issue on linear · {\"id\":\"LOG-1\",\"uuid\":\"ab8c7d32-1d2b-41e4-bb73-ff9cc8ec9281\",\"title\":\"Exception: SH-4471 held at Port Klang, Meridian Freight, no revised ETA\",\"description\":\"Shipment SH-4471 is held at Port Klang. The carrier, Meridian Freight, has not given a revised ETA.\n\nday0-demo-key: log-sh4471\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/LOG-1/exception-sh-4471-held-at-port-klang-meridian-freight-no-revised-eta\",\"gitBranchName\":\"<redacted>\",\"createdAt\":\"2026-09-18T14:18:35.578Z\",\"updatedAt\":\"2026-09-18T23:24:02.429Z\",\"archivedAt\":null,\"completedAt\":null,\"startedAt\":null,\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"Todo\",\"statusType\":\"unstarted\",\"labels\":[\"day0-demo\"],\"attachments\":[],\"documents\":[],\"stateHistory\":[{\"state\":{\"id\":\"e1c5a4e5-3343-4856-942a-71bd43bc02f6\",\"name\":\"Todo\",\"type\":\"unstarted\"},\"startedAt\":\"2026-09-18T14:18:35.578Z\",\"endedAt\":\"2026-09-18T14:58:46.971Z\"},{\"state\":{\"id\":\"f10a326c-9785-4efe-95cd-9373de6ffee8\",\"name\":\"Done\",\"type\":\"completed\"},\"startedAt\":\"2026-09-18T14:58:46.971Z\",\"endedAt\":\"2026-09-18T18:25:28.941Z\"},{\"state\":{\"id\":\"e1c5a4e5-3343-4856-942a-71bd43bc02f6\",\"name\":\"Todo\",\"type\":\"unstarted\"},\"startedAt\":\"2026-09-18T18:25:28.941Z\",\"endedAt\":\"2026-09-18T21:46:07.071Z\"},{\"state\":{\"id\":\"f10a326c-9785-4efe-95cd-9373de6ffee8\",\"name\":\"Done\",\"type\":\"completed\"},\"startedAt\":\"2026-09-18T21:46:07.071Z\",\"endedAt\":\"2026-09-18T23:24:02.423Z\"},{\"state\":{\"id\":\"e1c5a4e5-3343-4856-942a-71bd43bc02f6\",\"name\":\"Todo\",\"type\":\"unstarted\"},\"startedAt\":\"2026-09-18T23:24:02.423Z\",\"endedAt\":null}],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"Shipment exceptions\",\"projectId\":\"12037718-465c-4c21-a72f-2ff53d031816\",\"team\":\"Logistics desk\",\"teamId\":\"ed6a86e1-fa34-4ae2-abd0-9a83dba58f41\"}",
    "idempotencyKey": "nh7crv16ksaxkw9w9w0gsw0syd8enrw7:k97cc29kc02y5je3vkyhzht5fn8emy5q:0",
    "ok": true,
    "providerId": "LOG-1",
    "tool": "mcp.call"
  }
} as GroundingRead;

/** The manager DM the first run landed, carried on every later row. */
export const log1LandedWrites = [
  {
    "action": {
      "args": {
        "body": "{\"channel\":\"D0MANAGER\",\"text\":\"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight): the carrier has given no revised ETA, so per the logistics desk handbook ('Notices and ETAs') I need the desk lead's choice before writing the customer notice. Which of the two handbook templates should I use — 'Delay, revised ETA confirmed' or 'Delay, ETA unconfirmed, next update by <time>' (the latter looks like the fit)? And what next-update time should the notice promise? Once you answer, I will record the exception comment on LOG-1 and move it to Done, both held for your approval.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    },
    "applied": {
      "authority": "standing",
      "effect": "HTTP 200 · {\"ok\":true,\"channel\":\"D0MANAGER\",\"ts\":\"1789775147.261859\",\"message\":{\"subtype\":\"bot_message\",\"text\":\"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrie…",
      "idempotencyKey": "nh7crv16ksaxkw9w9w0gsw0syd8enrw7:k97cwet1cacrj0qygy57xgnf258em095:0",
      "ok": true,
      "providerId": "1789775147.261859",
      "tool": "http.request"
    }
  }
] as LandedWrite[];

/** The first retry's closing set as the row kept it: the read, the comment and Done, all four steps satisfied. */
export const log1RefusedClosing = {
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "get_issue",
        "toolArgsJson": "{\"id\":\"LOG-1\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_comment",
        "toolArgsJson": "{\"issueId\":\"LOG-1\",\"body\":\"Exception: SH-4471, held at Port Klang, Port Klang\\nCarrier: Meridian Freight; revised ETA: none given\\nCustomer notice (Delay, ETA unconfirmed, next update by <time>):\\nYour shipment SH-4471 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.\\nNext update: 17:00 SGT the next business day\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_issue",
        "toolArgsJson": "{\"id\":\"LOG-1\",\"state\":\"Done\"}"
      },
      "tool": "mcp.call"
    }
  ],
  "draft": "LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight, no revised ETA): your answer settles the escalation — use the \"Delay, ETA unconfirmed, next update by <time>\" template with the next update by 17:00 SGT the next business day. This response first reads LOG-1 in Linear to confirm the exception details as Linear reports them, then records the exception comment on LOG-1 in the 'How to record a shipment exception' format with every placeholder filled (shipment SH-4471, held at Port Klang, carrier Meridian Freight, revised ETA none given, next update 17:00 SGT the next business day), then moves LOG-1 to Done, the comment preceding the state change per the runbook. Both writes are held for your literal approval since autonomous actions are off. The escalation DM already landed (provider id 1789775147.261859); no further DM is sent.",
  "notes": "The manager's feedback supplies the template name and next-update time verbatim; the Linear read lands now and the comment and Done transition follow it in this same response, held for your approval.",
  "planStepOutcomes": [
    {
      "evidence": "get_issue on LOG-1 emitted in this response (action index 0) to read the exception details from Linear: shipment SH-4471, held at Port Klang, carrier Meridian Freight, revised ETA none given, matching the candidate body.",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "Landed write row: slack · POST /chat.postMessage · D0MANAGER · provider id 1789775147.261859 · \"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight): the carrier has given no revised ETA...\".",
      "status": "satisfied",
      "step": 2
    },
    {
      "basis": "manager-feedback",
      "evidence": "save_comment on LOG-1 emitted in this response (action index 1) in the 'How to record a shipment exception' format with the 'Delay, ETA unconfirmed, next update by <time>' template and next update 17:00 SGT the next business day per the manager's feedback: \"use the \\\"Delay, ETA unconfirmed, next update by <time>\\\" template, with the next update by 17:00 SGT the next business day.\"; held for manager approval.",
      "status": "satisfied",
      "step": 3
    },
    {
      "evidence": "save_issue moving LOG-1 to Done emitted in this response (action index 2), after the comment per the runbook; held for manager approval.",
      "status": "satisfied",
      "step": 4
    }
  ],
  "reason": "approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded",
  "at": 1789775363661
} as RefusedClosing;

/** The second retry's closing set, refused the same way. */
export const log1SecondRefusedClosing = {
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "get_issue",
        "toolArgsJson": "{\"id\":\"LOG-1\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_comment",
        "toolArgsJson": "{\"issueId\":\"LOG-1\",\"body\":\"Exception: SH-4471, held at Port Klang, Port Klang\\nCarrier: Meridian Freight; revised ETA: none given\\nCustomer notice (Delay, ETA unconfirmed, next update by <time>):\\nYour shipment SH-4471 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.\\nNext update: 17:00 SGT the next business day\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_issue",
        "toolArgsJson": "{\"id\":\"LOG-1\",\"state\":\"Done\"}"
      },
      "tool": "mcp.call"
    }
  ],
  "draft": "LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight, no revised ETA): the manager has answered the escalation, naming the 'Delay, ETA unconfirmed, next update by <time>' template with the next update by 17:00 SGT the next business day. I am reading LOG-1 in Linear to confirm the exception details as the plan's first step, then posting the exception comment on LOG-1 in the 'How to record a shipment exception' format with every placeholder filled from the ticket and the manager's answer, then moving LOG-1 to Done, comment first. No reply target exists (the work came from the Linear ticket queue), so no thread reply is needed.",
  "notes": "The manager's feedback supplies the template choice and next-update time (approved evidence); the escalation DM already landed in a prior run (provider id 1789775147.261859), so it is not re-sent. The plan's Linear read is emitted now as get_issue on LOG-1 to satisfy step 1 from the ledger.",
  "planStepOutcomes": [
    {
      "evidence": "get_issue on LOG-1 emitted as action index 0 in this response, confirming shipment SH-4471 held at Port Klang, carrier Meridian Freight, no revised ETA per the candidate body.",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "Landed row: slack · POST /chat.postMessage · D0MANAGER · provider id 1789775147.261859 · \"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight): the carrier has given no revised ETA...\"",
      "status": "satisfied",
      "step": 2
    },
    {
      "basis": "manager-feedback",
      "evidence": "save_comment on LOG-1 emitted as action index 1, filled from the ticket and the manager's answer (template 'Delay, ETA unconfirmed, next update by <time>', next update by 17:00 SGT the next business day).",
      "status": "satisfied",
      "step": 3
    },
    {
      "evidence": "save_issue moving LOG-1 to Done emitted as action index 2, after the comment in the same response, per the runbook ordering.",
      "status": "satisfied",
      "step": 4
    }
  ],
  "reason": "approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded",
  "at": 1789775911386
} as RefusedClosing;

/** The first run's phase one: the escalation DM, landed. */
export const log1FirstStopPhaseOne = {
  "actions": [
    {
      "args": {
        "body": "{\"channel\":\"D0MANAGER\",\"text\":\"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight): the carrier has given no revised ETA, so per the logistics desk handbook ('Notices and ETAs') I need the desk lead's choice before writing the customer notice. Which of the two handbook templates should I use — 'Delay, revised ETA confirmed' or 'Delay, ETA unconfirmed, next update by <time>' (the latter looks like the fit)? And what next-update time should the notice promise? Once you answer, I will record the exception comment on LOG-1 and move it to Done, both held for your approval.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    }
  ],
  "applied": [
    {
      "authority": "standing",
      "effect": "HTTP 200 · {\"ok\":true,\"channel\":\"D0MANAGER\",\"ts\":\"1789775147.261859\",\"message\":{\"subtype\":\"bot_message\",\"text\":\"Escalation on LOG-1 (shipment SH-4471, held at Port Klang, carrie…",
      "idempotencyKey": "nh7crv16ksaxkw9w9w0gsw0syd8enrw7:k97cwet1cacrj0qygy57xgnf258em095:0",
      "ok": true,
      "providerId": "1789775147.261859",
      "tool": "http.request"
    }
  ]
} as { actions: MockAction[]; applied: AppliedAction[] };

/**
 * The first run's closing set, from its `work.failed` event: the re-read
 * alone, with steps 3 and 4 blocked in the employee's own words. The stop
 * was right; the reason the card gave was the gate's, not hers.
 */
export const log1FirstStopRefusedClosing = {
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "get_issue",
        "toolArgsJson": "{\"id\":\"LOG-1\"}"
      },
      "tool": "mcp.call"
    }
  ],
  "draft": "LOG-1 (shipment SH-4471 held at Port Klang, carrier Meridian Freight, no revised ETA) is blocked pending the manager's answer to the escalation DM (ledger row 0, HTTP 200, ts 1789775147.261859). The logistics desk handbook ('Notices and ETAs') requires the desk lead's template choice and next-update time before the customer notice can be written, so the exception comment cannot be composed without leaving a <placeholder>. This closing turn re-reads LOG-1 in Linear to confirm the ticket's current state (a read, which lands now); no comment and no state change are emitted. When the manager answers, the next work item will record the exception comment in the 'How to record a shipment exception' format and then move LOG-1 to Done, both held for the manager's literal approval.",
  "notes": "Blocked on the manager's reply: template choice and next-update time for SH-4471 are unknown, so the notice text cannot be filled; the fresh get_issue read (action 0) is emitted now to satisfy plan step 1's declared Linear read.",
  "planStepOutcomes": [
    {
      "evidence": "Action 0 in this response: mcp.call get_issue on LOG-1 (linear), the declared Linear read confirming shipment SH-4471 held at Port Klang, carrier Meridian Freight, revised ETA none given.",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "Applied ledger row 0: http.request POST /chat.postMessage to manager DM D0MANAGER, HTTP 200, ts 1789775147.261859, escalation asking for template choice and next-update time.",
      "status": "satisfied",
      "step": 2
    },
    {
      "evidence": "No manager answer is in the applied ledger; the handbook ('Notices and ETAs') requires the desk lead's template choice and next-update time before the notice text can be filled, so save_comment on LOG-1 cannot be composed yet.",
      "status": "blocked",
      "step": 3
    },
    {
      "evidence": "Depends on step 3: the runbook 'How to record a shipment exception' requires the comment to precede any status change, and no comment has landed, so save_issue to Done is not emitted.",
      "status": "blocked",
      "step": 4
    }
  ],
  "reason": "approved plan step 1 declares a read of Linear, but no landed Linear read or blocking ledger reason was recorded",
  "at": 1789775169399
} as RefusedClosing;

export const fin1Candidate: WorkCandidate = { ...{
  "sourceCategory": "ticket-queue",
  "sourceSystem": "linear",
  "externalId": "FIN-1",
  "title": "Post the September close status note",
  "contentSummary": "Post the close status note for the September close on this ticket.\n\nday0-demo-key: fin-status",
  "contentRefs": [
    "https://linear.app/day00/issue/FIN-1/post-the-september-close-status-note"
  ],
  "requesterLabel": "Brian"
}, observedAt: new Date(1789774796239) } as WorkCandidate;

export const fin1Plan = {
  "estimatedMinutes": 20,
  "expectedOutputType": "ticket-update",
  "obligations": {
    "basis": "judgement",
    "reason": "Step 3 unconditionally moves FIN-1 to Done once the note comment is posted, per the runbook rule that the note is the deliverable.",
    "steps": [
      {
        "kind": "read",
        "reads": [
          "linear"
        ],
        "reason": "Lists and reads the FIN September close step tickets to capture identifiers, titles and states exactly as Linear reports them.",
        "writes": []
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Posts the close status note as one new top-level save_comment on FIN-1; the states quoted were read in step 1, not re-read here.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Moves FIN-1 to Done via save_issue because the note, the deliverable, has been posted.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [
          "slack"
        ],
        "reason": "Reads #finance-close history for open close-standing questions and replies in each such thread; writes only if a question exists.",
        "writes": [
          "slack"
        ]
      }
    ],
    "transition": "promised",
    "transitionStep": 3
  },
  "reversibility": "Comments and the status change on FIN-1 are reversible in Linear; Slack thread replies are visible but can be deleted. Step tickets are untouched.",
  "riskNotes": "No specific #finance-close question is attached to the candidate; if none is open, step 4 is a no-op. NetLedger has no connected surface, so step states are read only from Linear tickets, never from the books; any NetLedger need routes to the manager. Step tickets themselves are never modified.",
  "steps": [
    "Read the September close step tickets in Linear team FIN, project September close (list_issues, then get_issue as needed) to get 'Accruals booked' and 'Bank reconciliation' ticket identifiers, titles and states exactly as Linear reports them.",
    "Post the close status note as one new top-level comment on FIN-1 via save_comment, in runbook order: one line per step ticket in calendar order with its identifier, title and state, then the 'Not done yet:' line naming every step not at Done (or 'nothing').",
    "Move FIN-1 to Done via save_issue (state 'Done'), since the note is the deliverable and the comment is posted.",
    "Check #finance-close for open questions about where the close stands and reply in each question's thread with the same lines as the note (chat.postMessage with channel and thread_ts)."
  ],
  "summary": "Read the September close step tickets in Linear team FIN, write the close status note per the runbook format, post it as one comment on FIN-1, move FIN-1 to Done, and answer any close-standing questions in #finance-close threads with the same lines."
} as ExecutionPlan;

/** The note that removed FIN-1's Slack step. */
export const FIN_1_RETRY_NOTE = "This ticket needs no Slack call: leave out the conversations.list step. Read the September close tickets in Linear and post the status note as a comment on FIN-1, as the runbook says.";

/** FIN-1's phase one on the retry: one landed `list_issues`. */
export const fin1PhaseOne = {
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "list_issues",
        "toolArgsJson": "{\"team\":\"FIN\",\"project\":\"September close\",\"limit\":50}"
      },
      "tool": "mcp.call"
    }
  ],
  "applied": [
    {
      "authority": "autonomous",
      "effect": "list_issues on linear · {\"issues\":[{\"id\":\"FIN-4\",\"uuid\":\"1a321d38-c5be-410b-afb1-cd8151f5f8ac\",\"title\":\"Confirm the Brightwater accrual owner in NetLedger\",\"description\":\"Find who owns the Brightwater freight accrual in NetLedger and add the owner here.\\n\\nday0-demo-key: fin-brightwater\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/FIN-4/confirm-the-brightwater-accrual-owner-in-netledger\",\"gitBranchName\":\"<redacted>\",\"createdAt\":\"2026-09-18T18:25:27.568Z\",\"updatedAt\":\"2026-09-18T23:23:59.019Z\",\"archivedAt\":null,\"completedAt\":null,\"startedAt\":null,\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"Todo\",\"statusType\":\"unstarted\",\"labels\":[\"day0-demo\"],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"September close\",\"projectId\":\"5bad0674-f635-455f-a8da-bf8d43a059d7\",\"team\":\"Finance close\",\"teamId\":\"5feabff1-075d-4029-a318-954f4db96f01\"},{\"id\":\"FIN-3\",\"uuid\":\"ed68714b-9f4d-44c2-936f-38e591315295\",\"title\":\"Bank reconciliation for September\",\"description\":\"Close calendar step, business day 4: the accounting team reconciles the September bank statements in NetLedger.\\n\\nday0-demo-key: fin-bankrec\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/FIN-3/bank-reconciliation-for-september\",\"gitBranchName\":\"isaacbikjk/fin-3-bank-reconciliation-for-september\",\"createdAt\":\"2026-09-18T18:25:27.104Z\",\"updatedAt\":\"2026-09-18T23:23:57.148Z\",\"archivedAt\":null,\"completedAt\":null,\"startedAt\":\"2026-09-18T18:25:27.130Z\",\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"In Progress\",\"statusType\":\"started\",\"labels\":[\"day0-demo\"],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"September close\",\"projectId\":\"5bad0674-f635-455f-a8da-bf8d43a059d7\",\"team\":\"Finance close\",\"teamId\":\"5feabff1-075d-4029-a318-954f4db96f01\"},{\"id\":\"FIN-2\",\"uuid\":\"67461d7d-056f-427b-9b64-13bb787fd58c\",\"title\":\"Accruals booked for September\",\"description\":\"Close calendar step, business day 3: the accounting team books the September accruals in NetLedger.\\n\\nday0-demo-key: fin-accruals\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/FIN-2/accruals-booked-for-september\",\"gitBranchName\":\"isaacbikjk/fin-2-accruals-booked-for-september\",\"createdAt\":\"2026-09-18T18:25:26.631Z\",\"updatedAt\":\"2026-09-18T23:23:55.291Z\",\"archivedAt\":null,\"completedAt\":\"2026-09-18T18:25:26.659Z\",\"startedAt\":null,\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"Done\",\"statusType\":\"completed\",\"labels\":[\"day0-demo\"],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"September close\",\"projectId\":\"5bad0674-f635-455f-a8da-bf8d43a059d7\",\"team\":\"Finance close\",\"teamId\":\"5feabff1-075d-4029-a318-954f4db96f01\"},{\"id\":\"FIN-1\",\"uuid\":\"8fe4bfa1-3f35-4aa9-abf3-07cd5700c3b1\",\"title\":\"Post the September close status note\",\"description\":\"Post the close status note for the September close on this ticket.\\n\\nday0-demo-key: fin-status\",\"priority\":{\"value\":0,\"name\":\"No priority\"},\"url\":\"https://linear.app/day00/issue/FIN-1/post-the-september-close-status-note\",\"gitBranchName\":\"isaacbikjk/fin-1-post-the-september-close-status-note\",\"createdAt\":\"2026-09-18T14:18:35.053Z\",\"updatedAt\":\"2026-09-18T23:23:53.497Z\",\"archivedAt\":null,\"completedAt\":null,\"startedAt\":null,\"canceledAt\":null,\"dueDate\":null,\"slaStartedAt\":null,\"slaMediumRiskAt\":null,\"slaHighRiskAt\":null,\"slaBreachesAt\":null,\"status\":\"Todo\",\"statusType\":\"unstarted\",\"labels\":[\"day0-demo\"],\"createdBy\":\"Brian\",\"createdById\":\"11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f\",\"project\":\"September close\",\"projectId\":\"5bad0674-f635-455f-a8da-bf8d43a059d7\",\"team\":\"Finance close\",\"teamId\":\"5feabff1-075d-4029-a318-954f4db96f01\"}],\"hasNextPage\":false}",
      "idempotencyKey": "nh74n2epmq199f0hpdg4wtrj198en3bt:k97bscb5p70v2tbzjcn3bsfns98en58d:0",
      "ok": true,
      "providerId": "FIN-4",
      "tool": "mcp.call"
    }
  ]
} as { actions: MockAction[]; applied: AppliedAction[] };

/** FIN-1's closing set, refused for the Slack read the note had removed. */
export const fin1RefusedClosing = {
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "save_comment",
        "toolArgsJson": "{\"issueId\":\"FIN-1\",\"body\":\"Accruals booked: FIN-2 Accruals booked for September, Done\\nBank reconciliation: FIN-3 Bank reconciliation for September, In Progress\\nNot done yet: Bank reconciliation (FIN-3, In Progress)\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_issue",
        "toolArgsJson": "{\"id\":\"FIN-1\",\"state\":\"Done\"}"
      },
      "tool": "mcp.call"
    }
  ],
  "draft": "September close status note (per 'How to write the close status note'):\n\nAccruals booked: FIN-2 Accruals booked for September, Done\nBank reconciliation: FIN-3 Bank reconciliation for September, In Progress\nNot done yet: Bank reconciliation (FIN-3, In Progress)\n\nThis note is emitted as one new top-level comment on FIN-1, and FIN-1 is then moved to Done. States are quoted exactly as Linear reported them in the applied list_issues read (ledger row 0). Per your feedback, no Slack read or post is emitted for this work item.",
  "notes": "FIN-4 (Brightwater accrual owner) is not a close-calendar step ticket, so it is not a line in the note. No #finance-close reply is emitted: your feedback states this ticket needs no Slack call, so step 4's Slack read is settled by that instruction rather than performed. The comment and state change are emitted in that order so the status change is never the only trace of who acted.",
  "planStepOutcomes": [
    {
      "evidence": "Applied ledger row 0: list_issues on linear returned FIN-2 'Accruals booked for September' (Done), FIN-3 'Bank reconciliation for September' (In Progress), FIN-1 'Post the September close status note' (Todo), FIN-4 (not a calendar step).",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "Action index 0: save_comment on FIN-1 with the note in runbook order (calendar-order step lines, then 'Not done yet:' naming FIN-3).",
      "status": "satisfied",
      "step": 2
    },
    {
      "evidence": "Action index 1: save_issue moving FIN-1 to state 'Done', emitted after the comment per the runbook.",
      "status": "satisfied",
      "step": 3
    },
    {
      "basis": "manager-feedback",
      "evidence": "Manager feedback: \"This ticket needs no Slack call: leave out the conversations.list step.\" No Slack read or post is emitted for this work item.",
      "status": "satisfied",
      "step": 4
    }
  ],
  "reason": "approved plan step 4 declares a read of Slack, but no landed Slack read or blocking ledger reason was recorded",
  "at": 1789776007486
} as RefusedClosing;
