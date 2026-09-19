import type { DependentExecutionOutput, ExecutionOutput, ExecutionPlan, WorkCandidate } from '../../../src/work/types';

/**
 * Aiko's LOG-1 (SH-4471) and LOG-3 (SH-4480) from the fourth full internal
 * run of 19 September (main 0ba9479, real mode, autonomy off), and LOG-1 from
 * the second sitting of the same day, which stopped where the fourth did not.
 * Every string is the runs' own, read from the fourth run's findings row and
 * the two exports; only the manager's DM channel id is replaced, `observedAt`
 * is rebuilt as a date and the plan's correction ids are left to the test,
 * which inserts the rows they name.
 */

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
}, observedAt: new Date(1789782360619) } as WorkCandidate;

/** The approved plan: a DM step, then a comment and a Done the judgement made `conditional-write` under `conditional-on-manager`; no read declared. */
export const log1Plan = {
  "estimatedMinutes": 15,
  "expectedOutputType": "ticket-update",
  "obligations": {
    "basis": "judgement",
    "reason": "The plan moves LOG-1 to Done only if and after the manager answers the template question; without the answer the ticket stays in Todo.",
    "steps": [
      {
        "kind": "write",
        "reads": [],
        "reason": "Send the escalation question about the customer-notice template to the manager DM; no surface is read.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Post the exception comment on LOG-1 only once the manager has chosen the template and next-update time; the payload is held for approval.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Move LOG-1 to Done only after the comment is posted and the manager has answered; otherwise the ticket stays in Todo.",
        "writes": [
          "linear"
        ]
      }
    ],
    "transition": "conditional-on-manager",
    "transitionStep": 3
  },
  "reversibility": "The manager DM is informational. The Linear comment and status change are held for exact-payload approval; a posted comment can be followed by a correcting comment and the status can be moved back to Todo.",
  "riskNotes": "The template choice and next-update time cannot be settled from the ticket or the handbook — the handbook routes that to the desk lead, reached here via the manager DM — so the recording step is conditional on the manager's answer. No thread reply is needed: the exception was raised on the Linear ticket, not in #logistics-desk. Sending the customer notice itself is not in scope; the account team sends it from the ticket, and the charter forbids sending any notice without manager approval.",
  "steps": [
    "DM the manager in Slack (manager DM, opened per the Slack automation policy): SH-4471 (LOG-1) is held at Port Klang, carrier Meridian Freight has given no revised ETA, so per the logistics handbook ask which customer-notice template to use and what next-update time to promise; note the draft will come back for approval before anything is sent.",
    "Once the manager answers, post one comment on LOG-1 in the 'How to record a shipment exception' format: Exception: SH-4471, held at Port Klang, Port Klang; Carrier: Meridian Freight; revised ETA: none given; Customer notice (<template name the manager chose>) with every placeholder filled and the promised next-update time; Next update: <time or none>. Held for the manager's approval of the exact payload.",
    "After the comment is posted, move LOG-1 to Done via save_issue (state 'Done'), held for the manager's approval. If the manager has not answered, the ticket stays in Todo and the run stops with the open question."
  ],
  "summary": "LOG-1 records SH-4471 held at Port Klang with Meridian Freight and no revised ETA. The handbook's 'Delay, ETA unconfirmed' template requires a next-update time, and the handbook says when the carrier has given no ETA, ask the desk lead which template to use before writing to the customer. That question about a customer notice is an escalation trigger, so it goes to the manager DM now; the ticket comment and status change wait on the manager's answer. Autonomous actions are off, so the DM lands now and every other write is held for the manager's literal approval."
} as ExecutionPlan;

/** The one phase the fourth sitting emitted: the read, the question, and the two writes the plan left to the manager's answer. */
export const log1PhaseOne = {
  "draft": "SH-4471 (LOG-1) is held at Port Klang; carrier Meridian Freight has given no revised ETA. The logistics handbook's 'Notices and ETAs' section says that when the carrier has given none, the desk lead decides which template to use and sets the next-update time, so I have asked you in the manager DM which of the two templates to use and what next-update time to promise. In the meantime this run records the exception on LOG-1 as one comment in the 'How to record a shipment exception' format, with the exception lines filled from the ticket and the customer notice deliberately left pending your answer (a notice still carrying a placeholder is not ready, per the runbook). The comment lands held for your approval of the exact payload, since autonomous actions are off. Once the comment is posted, LOG-1 moves to Done via save_issue, also held for your approval. Per the charter, no customer notice is sent out without your approval; the account team sends the notice from the ticket after it is recorded.",
  "notes": "The customer-notice template name and next-update time are unknown until you answer; the comment records the exception and names those values as deliberately left pending rather than carrying an unfilled placeholder. Autonomous actions are off, so the Linear read and the manager DM land now; the LOG-1 comment and the Done state change are held for your literal approval.",
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
        "body": "{\"channel\":\"D0MANAGER\",\"text\":\"SH-4471 (LOG-1) is held at Port Klang; carrier Meridian Freight has given no revised ETA. Per the logistics handbook ('Notices and ETAs'), when the carrier has given no ETA I ask the desk lead which customer-notice template to use and what next-update time to promise before writing to the customer. Which template should the notice use ('Delay, revised ETA confirmed' or 'Delay, ETA unconfirmed, next update by <time>'), and what next-update time should it promise? I could not confirm the answer from the ticket or the handbook, so I am asking. The exception comment on LOG-1 is being recorded now with the notice left pending your answer, and per the charter no customer notice goes out without your approval.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_comment",
        "toolArgsJson": "{\"issueId\":\"LOG-1\",\"body\":\"Exception: SH-4471, held at Port Klang, Port Klang\\nCarrier: Meridian Freight; revised ETA: none given\\nCustomer notice: pending - the carrier gave no revised ETA, so per the logistics handbook the desk lead chooses the template and sets the next-update time; the notice text will be added once the manager confirms them. No customer notice has been sent.\\nNext update: none yet\"}"
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
  "needsDependentPhase": false
} as ExecutionOutput;

/** The correction the manager gave, word for word from the company bed's answers. */
export const LOG_1_RETRY_NOTE = "For a Meridian Freight hold at Port Klang with no revised ETA, use the \"Delay, ETA unconfirmed, next update by <time>\" template, with the next update by 17:00 SGT the next business day.";

/** The second sitting's plan for the same ticket: the same declared shape. */
export const log1SecondSittingPlan = {
  "estimatedMinutes": 15,
  "expectedOutputType": "ticket-update",
  "obligations": {
    "basis": "judgement",
    "reason": "The plan moves LOG-1 to Done only after the desk lead answers the template question and the manager approves the exact comment and status payloads.",
    "steps": [
      {
        "kind": "write",
        "reads": [],
        "reason": "Send the desk lead's template question for SH-4471 to the manager DM; no surface is read to ask it.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Post the exception comment on LOG-1 only once the desk lead answers which template and next-update time apply.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Move LOG-1 to Done via save_issue only after the exception comment has landed and the manager approves the payload.",
        "writes": [
          "linear"
        ]
      }
    ],
    "transition": "conditional-on-manager",
    "transitionStep": 3
  },
  "reversibility": "The DM is informational. The Linear comment can be rewritten or a new comment added; a Done status can be reopened. Low risk.",
  "riskNotes": "The template choice and next-update time are the desk lead's call; the data cannot settle them, so the comment waits on that answer. The comment and status change are writes and are held while autonomous actions are off — the manager must approve the literal payloads. The account team sends the notice from the ticket; I never send anything to the customer.",
  "steps": [
    "DM the manager (which reaches the desk lead) with the template question for SH-4471: carrier gave no revised ETA, so which of the two handbook templates applies and what next-update time to promise.",
    "Once the desk lead answers, post the exception comment on LOG-1 in the documented format with the notice text fully filled from the answer (held for manager approval of the exact text).",
    "After the comment lands, move LOG-1 to Done via save_issue (held for manager approval)."
  ],
  "summary": "LOG-1 records a routine exception (SH-4471 held at Port Klang, Meridian Freight) but with no revised ETA. The handbook says when the carrier has given no ETA, the desk lead chooses the template and sets the next-update time before any customer notice is written. So the notice text cannot be filled yet; I escalate that question now (manager DM lands immediately), and hold the ticket comment and status change for the manager's approval of the exact payloads."
} as ExecutionPlan;

/** The second sitting's phase one as it landed: the question alone. */
export const log1SecondSittingPhaseOne = [
  {
    "args": {
      "body": "{\"channel\":\"D0MANAGER\",\"text\":\"Question for the desk lead on LOG-1 (shipment SH-4471, held at Port Klang, carrier Meridian Freight): the carrier gave no revised ETA, so per the logistics handbook the desk lead chooses the template and sets the next-update time before any customer notice is written. Which of the two handbook templates applies to SH-4471, and what next-update time should the notice promise? Once I have the answer I will post the exception comment on LOG-1 and move it to Done, held for your approval of the exact text.\"}",
      "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
      "method": "POST",
      "path": "/chat.postMessage",
      "surface": "slack"
    },
    "tool": "http.request"
  }
] as ExecutionOutput['actions'];

/** The second sitting's closing set: no action, steps 2 and 3 blocked in her words. */
export const log1SecondSittingClosing = {
  "draft": "LOG-1 (SH-4471 held at Port Klang, Meridian Freight, no revised ETA) — status: waiting on the desk lead's answer.\n\nDone so far: the manager DM asking which handbook template applies and what next-update time to promise landed (Slack ts 1789767817.837079, HTTP 200).\n\nNot done yet, by design: the exception comment on LOG-1 cannot be written until the desk lead names the template and the next-update time — a notice still carrying a <placeholder> is not ready per 'How to record a shipment exception'. The Done state change follows only after the comment lands. Both are held for the manager's approval of the exact payloads and will be emitted once the answer arrives; no comment or state change has been posted on LOG-1 in this run.",
  "notes": "The desk lead's template/next-update answer is not in the applied ledger, so the notice text and the LOG-1 comment/state change remain unwritten; no further turn exists in this run, so they are left for the manager to trigger once the answer arrives.",
  "actions": [],
  "planStepOutcomes": [
    {
      "evidence": "Ledger row 0: http.request POST /chat.postMessage to D0MANAGER landed HTTP 200 (ts 1789767817.837079) asking the desk lead which template applies to SH-4471 and the next-update time.",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "No desk lead answer exists in the applied ledger, so the notice text cannot be filled without a placeholder; per 'How to record a shipment exception' the comment is not ready and was not emitted.",
      "status": "blocked",
      "step": 2
    },
    {
      "evidence": "Depends on step 2's comment landing first; no comment exists in the ledger, so no save_issue Done transition was emitted.",
      "status": "blocked",
      "step": 3
    }
  ]
} as DependentExecutionOutput;

/** The second sitting's stop reason as the card showed it. */
export const LOG_1_SECOND_SITTING_STOP = "stopped: 2 approved plan step(s) remained blocked: step 2 (No desk lead answer exists in the applied ledger, so the notice text cannot be filled without a placeholder; per 'How to record a shipment exception' the comment is not ready and was not emitted.); step 3 (Depends on step 2's comment landing first; no comment exists in the ledger, so no save_issue Done transition was emitted.)";

export const log3Candidate: WorkCandidate = { ...{
  "sourceCategory": "ticket-queue",
  "sourceSystem": "linear",
  "externalId": "LOG-3",
  "title": "Exception: SH-4480 held at Port Klang, Meridian Freight, no revised ETA",
  "contentSummary": "Shipment SH-4480 is held at Port Klang. The carrier, Meridian Freight, has not given a revised ETA.\n\nday0-demo-key: log-sh4480",
  "contentRefs": [
    "https://linear.app/day00/issue/LOG-3/exception-sh-4480-held-at-port-klang-meridian-freight-no-revised-eta"
  ],
  "requesterLabel": "Brian"
}, observedAt: new Date(1789783197004) } as WorkCandidate;

/** SH-4480's approved plan, the same declared shape as LOG-1's; it applied the two corrections kept from LOG-1. */
export const log3Plan = {
  "estimatedMinutes": 15,
  "expectedOutputType": "ticket-update",
  "obligations": {
    "basis": "judgement",
    "reason": "The plan moves LOG-3 to Done only on the manager's approval of the comment; the state change is gated on the manager, not on evidence read back.",
    "steps": [
      {
        "kind": "report",
        "reads": [],
        "reason": "Composing the exception comment text in the response; no surface is touched.",
        "writes": []
      },
      {
        "kind": "write",
        "reads": [],
        "reason": "Posts the draft to the manager DM via chat.postMessage for approval.",
        "writes": [
          "slack"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Posts the exception comment on LOG-3 via save_comment only if the manager approves the draft.",
        "writes": [
          "linear"
        ]
      },
      {
        "kind": "conditional-write",
        "reads": [],
        "reason": "Moves LOG-3 to Done via save_issue only after the manager approves the posted comment.",
        "writes": [
          "linear"
        ]
      }
    ],
    "transition": "conditional-on-manager",
    "transitionStep": 4
  },
  "reversibility": "The Linear comment can be edited or superseded by a later comment; the status change to Done can be reverted in Linear. The manager DM is informational.",
  "riskNotes": "The template choice and next-update time rest on the manager's corrections from the SH-4471 case, not on a fresh desk-lead answer; if the manager prefers to re-confirm with the desk lead for this customer, the draft can be adjusted before posting. The customer notice itself is never sent by Day0 — the account team sends it from the ticket, and the charter forbids sending notices without manager approval.",
  "steps": [
    "Draft the exception comment for LOG-3 in the documented format: Exception: SH-4480, held at Port Klang; Carrier: Meridian Freight; revised ETA: none given; Customer notice (Delay, ETA unconfirmed, next update by <time>): 'Your shipment SH-4480 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.'; Next update: 17:00 SGT the next business day.",
    "Send the draft to the manager in the manager DM via the slack surface (chat.postMessage to the manager DM channel id from the surface), noting it comes from LOG-3 and asking for approval of the exact comment text before it is posted.",
    "On the manager's approval, post the approved comment on LOG-3 via linear save_comment (issueId LOG-3, body as approved).",
    "On the manager's approval of the comment, move LOG-3 to Done via linear save_issue, per the handbook's exception process."
  ],
  "summary": "Exception LOG-3: SH-4480 held at Port Klang, Meridian Freight, no revised ETA. Per the manager's earlier corrections on the identical SH-4471 case, use the 'Delay, ETA unconfirmed, next update by <time>' template with next update by 17:00 SGT the next business day. Draft the exception comment, DM the draft to the manager now (reads and the manager DM land while autonomous actions are off); the Linear comment and status change are held for the manager's literal approval."
} as ExecutionPlan;

/** SH-4480's one phase: the comment, Done, and the draft sent to the manager. */
export const log3PhaseOne = {
  "draft": "Draft for LOG-3 (Exception: SH-4480 held at Port Klang, Meridian Freight, no revised ETA), prepared for your approval before anything is posted:\n\nException: SH-4480, held at Port Klang\nCarrier: Meridian Freight; revised ETA: none given\nCustomer notice (Delay, ETA unconfirmed, next update by <time>):\nYour shipment SH-4480 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.\nNext update: 17:00 SGT the next business day\n\nTemplate chosen per your earlier correction on the identical SH-4471 case (Meridian Freight hold at Port Klang, no revised ETA): 'Delay, ETA unconfirmed, next update by <time>', with the next update by 17:00 SGT the next business day.\n\nProposed sequence once you approve the exact text: post the comment on LOG-3 via linear save_comment, then move LOG-3 to Done via linear save_issue. Both writes are held for your literal approval while autonomous actions are off. Please approve or correct the comment text above.",
  "notes": "Assumes the manager's SH-4471 correction applies verbatim to SH-4480 as the approved plan states; no Reply target line exists, so no channel reply is emitted, and the Linear comment and status change are held for the manager's literal approval.",
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "save_comment",
        "toolArgsJson": "{\"issueId\":\"LOG-3\",\"body\":\"Exception: SH-4480, held at Port Klang\\nCarrier: Meridian Freight; revised ETA: none given\\nCustomer notice (Delay, ETA unconfirmed, next update by <time>):\\nYour shipment SH-4480 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.\\nNext update: 17:00 SGT the next business day\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "save_issue",
        "toolArgsJson": "{\"id\":\"LOG-3\",\"state\":\"Done\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "body": "{\"channel\":\"D0MANAGER\",\"text\":\"Draft for LOG-3 (Exception: SH-4480 held at Port Klang, Meridian Freight, no revised ETA), for your approval before anything is posted:\\n\\nException: SH-4480, held at Port Klang\\nCarrier: Meridian Freight; revised ETA: none given\\nCustomer notice (Delay, ETA unconfirmed, next update by <time>):\\nYour shipment SH-4480 is delayed at Port Klang. Meridian Freight has not yet confirmed a revised delivery date. We will update you by 17:00 SGT the next business day.\\nNext update: 17:00 SGT the next business day\\n\\nTemplate chosen per your earlier correction on the identical SH-4471 case. On your approval of this exact text I will post the comment on LOG-3 and then move LOG-3 to Done; both writes are held for your literal approval.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    }
  ],
  "needsDependentPhase": false
} as ExecutionOutput;
