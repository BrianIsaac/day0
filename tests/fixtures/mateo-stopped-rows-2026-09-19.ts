/**
 * The 19 Sep third full run's two stopped rows of Mateo's (findings R and S),
 * as `findings/mateo-stopped-rows-0744.jsonl` kept them. `FIN_1_ITEM` is the
 * ticket's own item: `list_issues` landed, then `POST /conversations.list`, a
 * Slack read, was refused as an unattributable write and the run stopped.
 * `FINANCE_CLOSE_ASK` is the `#finance-close` ask: its executor obeyed the
 * held-items block, authored no FIN-1 write, reported steps 3 and 5 blocked,
 * and the stop withheld its thread reply. Values are verbatim from the rows;
 * only each ledger `effect` is cut at 300 characters.
 */
import type { MockAction } from '../../src/work/types';

export const FIN_1_ITEM = {
  "workItemId": "nh74n2epmq199f0hpdg4wtrj198en3bt",
  "title": "Post the September close status note",
  "contentSummary": "Post the close status note for the September close on this ticket.\n\nday0-demo-key: fin-status",
  "externalId": "FIN-1",
  "skipReason": "stopped: Day0's gate refused 1 of 2 actions before sending it, so the steps that needed it were not done; the other 1 landed and stays as it is. Refused: POST /conversations.list on slack (refused before sending: under the shared credential this write would carry nothing naming the employee or the run. A new ticket needs a title and a description for Day0 to sign; a change to an existing ticket needs an audit comment on it first). Retry with a note that changes the step, or do it by hand",
  "plan": {
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
  },
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "list_issues",
        "toolArgsJson": "{\"team\":\"FIN\",\"project\":\"September close\",\"limit\":50}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "body": "{}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/conversations.list",
        "surface": "slack"
      },
      "tool": "http.request"
    }
  ],
  "applied": [
    {
      "authority": "autonomous",
      "effect": "list_issues on linear · {\"issues\":[{\"id\":\"FIN-4\",\"uuid\":\"1a321d38-c5be-410b-afb1-cd8151f5f8ac\",\"title\":\"Confirm the Brightwater accrual owner in NetLedger\",\"description\":\"Find who owns the Brightwater freight accrual in NetLedger and add the owner here.\\n\\nday0-demo-key: fin-brightwater\",\"priority\":",
      "idempotencyKey": "nh74n2epmq199f0hpdg4wtrj198en3bt:k97edmn8vaxrdvz5xybe8gkmb18ent3h:0",
      "ok": true,
      "providerId": "FIN-4",
      "tool": "mcp.call"
    },
    {
      "idempotencyKey": "nh74n2epmq199f0hpdg4wtrj198en3bt:k97edmn8vaxrdvz5xybe8gkmb18ent3h:1",
      "ok": false,
      "reason": "refused before sending: under the shared credential this write would carry nothing naming the employee or the run. A new ticket needs a title and a description for Day0 to sign; a change to an existing ticket needs an audit comment on it first",
      "tool": "http.request"
    }
  ],
  "deferredActions": [
    {
      "dependsOnActionIndex": 1,
      "dependsOnField": "channels",
      "description": "Read #finance-close history (conversations.history with the channel id from conversations.list) and reply in each open question's thread about where the close stands with the same lines as the note (chat.postMessage with channel and thread_ts).",
      "reason": "The thread replies depend on the #finance-close channel id from the conversations.list read in this response and on the note content; the history read and replies are authored in the closing phase."
    }
  ]
};

export const FINANCE_CLOSE_ASK = {
  "workItemId": "nh7bf0b5gp8psrcvnqpgmhq9wh8en1mg",
  "title": "Slack mention in #finance-close",
  "contentSummary": "<@U0BTFK6FLNL> can you post where the September close stands?",
  "externalId": "C0C2P932A2H:1789761522.764859",
  "skipReason": "stopped: 2 approved plan step(s) remained blocked: step 3 (The save_comment on FIN-1 is withheld: FIN-1 is an external item with its own claimed work item ('Post the September close status note'), so a write to it from this run is never sent. The note will be posted there by that work item.); step 5 (The save_issue moving FIN-1 to Done is withheld: FIN-1 has its own claimed work item, and the prerequisite note comment was not posted from this run, so no Done transition is emitted here.)",
  "plan": {
    "estimatedMinutes": 20,
    "expectedOutputType": "ticket-update",
    "obligations": {
      "basis": "judgement",
      "plannerTransition": "conditional-on-manager",
      "reason": "The status ticket moves to Done only after the run confirms the note comment landed on it; the write is held for manager approval and gated on that evidence.",
      "steps": [
        {
          "kind": "read",
          "reads": [
            "linear"
          ],
          "reason": "Lists the FIN September close step tickets and the status ticket, recording identifiers, titles and states as Linear reports them.",
          "writes": []
        },
        {
          "kind": "report",
          "reads": [],
          "reason": "Drafts the note and thread reply text in the response for manager review; touches no surface.",
          "writes": []
        },
        {
          "kind": "write",
          "reads": [],
          "reason": "Posts the close status note as one save_comment on the status ticket, held for the manager's approval of the exact text.",
          "writes": [
            "linear"
          ]
        },
        {
          "kind": "write",
          "reads": [],
          "reason": "Replies in the #finance-close thread with the note lines via chat.postMessage, held for the manager's approval of the exact text.",
          "writes": [
            "slack"
          ]
        },
        {
          "kind": "conditional-write",
          "reads": [
            "linear"
          ],
          "reason": "Moves the status ticket to Done via save_issue only once the note comment is confirmed posted on it.",
          "writes": [
            "linear"
          ]
        }
      ],
      "transition": "conditional-on-evidence",
      "transitionStep": 5
    },
    "reversibility": "Linear comment and Slack reply are additive and can be followed by a correcting comment; the status move to Done is reversible in Linear.",
    "riskNotes": "NetLedger has no connected surface; step states are read from tickets only, never the books — any question needing the ledger goes to the manager. The flash report has no ticket and is excluded from the note. Both public writes need the manager's literal approval before they land.",
    "steps": [
      "Read Linear team FIN, project September close: list the step tickets (Accruals booked, Bank reconciliation) and find the status ticket titled 'Post the September close status note', recording each ticket's identifier, title and state exactly as Linear reports it.",
      "Draft the close status note in the runbook format (one line per step in calendar order with identifier, title, state; then 'Not done yet:' line) and the thread reply with the same lines, for manager review.",
      "Post the note as one save_comment on the status ticket (held for manager approval of the exact text).",
      "Reply in the #finance-close thread (channel C0B2P932A2H, thread_ts 1789761522.764859) with the same lines via chat.postMessage (held for manager approval of the exact text).",
      "Once the note comment is posted, move the status ticket to Done via save_issue (held for manager approval; only after the comment lands)."
    ],
    "summary": "Read the FIN September close step tickets and the status ticket in Linear, draft the close status note per the runbook, then post the note as a comment on the status ticket and reply in the #finance-close thread. Both writes are held for the manager's literal approval (autonomous actions off). Once the note comment lands, the status ticket moves to Done."
  },
  "actions": [
    {
      "args": {
        "surface": "linear",
        "tool": "list_issues",
        "toolArgsJson": "{\"team\":\"FIN\",\"project\":\"September close\",\"limit\":50}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "body": "{\"channel\":\"C0C2P932A2H\",\"thread_ts\":\"1789761522.764859\",\"text\":\"Where the September close stands (from the step tickets in Linear, team FIN, project September close):\\nAccruals booked: FIN-2 Accruals booked for September, Done\\nBank reconciliation: FIN-3 Bank reconciliation for September, In Progress\\nNot done yet: Bank reconciliation (FIN-3, In Progress)\\nThe close status note itself will be posted on FIN-1 (Post the September close status note), which has its own work item.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    },
    {
      "args": {
        "body": "{\"channel\":\"D0BS5SXMXPZ\",\"text\":\"Answered the #finance-close close-status ask in thread C0C2P932A2H:1789761522.764859 with the step states read from Linear (FIN-2 Done, FIN-3 In Progress). The note comment and Done transition on FIN-1 were not emitted from this run: FIN-1 has its own claimed work item, so those writes belong there.\"}",
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
      "authority": "autonomous",
      "effect": "list_issues on linear · {\"issues\":[{\"id\":\"FIN-4\",\"uuid\":\"1a321d38-c5be-410b-afb1-cd8151f5f8ac\",\"title\":\"Confirm the Brightwater accrual owner in NetLedger\",\"description\":\"Find who owns the Brightwater freight accrual in NetLedger and add the owner here.\\n\\nday0-demo-key: fin-brightwater\",\"priority\":",
      "idempotencyKey": "nh7bf0b5gp8psrcvnqpgmhq9wh8en1mg:k977yk8wf2t632bbxbzns1ta3x8eng7g:0",
      "ok": true,
      "providerId": "FIN-4",
      "tool": "mcp.call"
    },
    {
      "effect": "http.request slack · POST /chat.postMessage · headers {Authorization: \"Bearer {{secret}}\", Content-Type: \"application/json; charset=utf-8\"} · body \"{\"channel\":\"C0C2P932A2H\",\"thread_ts\":\"1789761522.764859\",\"text\":\"Where the September close stands (from the step tickets in Linear, team FIN, project Se",
      "held": true,
      "idempotencyKey": "nh7bf0b5gp8psrcvnqpgmhq9wh8en1mg:k977yk8wf2t632bbxbzns1ta3x8eng7g:1",
      "ok": true,
      "reason": "withheld: the run stopped with nothing landed and nothing for the manager to decide",
      "tool": "http.request"
    },
    {
      "effect": "http.request slack · POST /chat.postMessage · headers {Authorization: \"Bearer {{secret}}\", Content-Type: \"application/json; charset=utf-8\"} · body \"{\"channel\":\"D0BS5SXMXPZ\",\"text\":\"Answered the #finance-close close-status ask in thread C0C2P932A2H:1789761522.764859 with the step states read from Lin",
      "held": true,
      "idempotencyKey": "nh7bf0b5gp8psrcvnqpgmhq9wh8en1mg:k977yk8wf2t632bbxbzns1ta3x8eng7g:2",
      "ok": true,
      "reason": "withheld: the run stopped with nothing landed and nothing for the manager to decide",
      "tool": "http.request"
    }
  ],
  "planStepOutcomes": [
    {
      "evidence": "Ledger row 0: list_issues on linear returned FIN-2 'Accruals booked for September' (Done), FIN-3 'Bank reconciliation for September' (In Progress), FIN-4 (not a calendar step) and FIN-1 'Post the September close status note' (Todo).",
      "status": "satisfied",
      "step": 1
    },
    {
      "evidence": "Note drafted in runbook format in this response's draft from the ledger's reported states; thread reply text written with the same lines.",
      "status": "satisfied",
      "step": 2
    },
    {
      "evidence": "The save_comment on FIN-1 is withheld: FIN-1 is an external item with its own claimed work item ('Post the September close status note'), so a write to it from this run is never sent. The note will be posted there by that work item.",
      "status": "blocked",
      "step": 3
    },
    {
      "evidence": "Action index 0: chat.postMessage to channel C0C2P932A2H, thread_ts 1789761522.764859, with the note lines and a statement that the note will be posted on FIN-1 by its own work item (channel taken from the candidate's Reply target line, which supersedes the plan's C0B2P932A2H).",
      "status": "satisfied",
      "step": 4
    },
    {
      "evidence": "The save_issue moving FIN-1 to Done is withheld: FIN-1 has its own claimed work item, and the prerequisite note comment was not posted from this run, so no Done transition is emitted here.",
      "status": "blocked",
      "step": 5
    }
  ],
  "prerequisiteCount": 1,
  "replyTarget": {
    "channel": "C0C2P932A2H",
    "channelName": "finance-close",
    "threadTs": "1789761522.764859"
  }
};

export const FIN_1_ITEM_ACTIONS = FIN_1_ITEM.actions as MockAction[];
export const FINANCE_CLOSE_ASK_ACTIONS = FINANCE_CLOSE_ASK.actions as MockAction[];
