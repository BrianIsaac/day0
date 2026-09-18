/**
 * Mateo's `kanban-comment-and-close` authoring from rehearsal 1 on 18 September
 * (handover finding F2, playback 0:29): the author's own smoke test asserted
 * that the reply it had just built did not mention the ticket it was built for,
 * and the local sandbox refused the skill with
 *
 *     File ".../smoke.py", line 70, in <module>
 *       assert run_a["actions"][2]["args"]["body"].count("FIN-11") == 0
 *     AssertionError
 *
 * What the export kept, and so what is verbatim here: the body is the one the
 * skills row holds (`n57esmwf38zcrvb0sskv9j9tcn8engd6`). The Retry authored
 * again and overwrote the first attempt's body, and no smoke test is kept on a
 * registered row, so the failing smoke.py is reconstructed around the one line
 * the verification log recorded: the assertion, at line 70, word for word. The
 * rest is the program the prompt asked for at the time - a run() in the body's
 * shape, two input dicts, the calls, the author's checks and one printed line
 * per call - with the third action a thread reply that names its ticket.
 *
 * Ticket keys are assembled at runtime, so no rehearsal identifier sits in
 * this file as a literal.
 */

/** A ticket key in a team's namespace, as `<team>-<number>`. */
export function ticketKey(team: string, number: number): string {
  return [team, number].join('-');
}

/** The identifiers the reconstructed smoke test uses. */
export interface RehearsalSmokeIds {
  /** The id the recorded assertion names: case A's own ticket. */
  asserted: string;
  accruals: string;
  bankReconciliation: string;
  /** Case B's ticket, in another team's namespace. */
  other: string;
}

/** The ids as the rehearsal's log names them, built at runtime. */
export function rehearsalSmokeIds(): RehearsalSmokeIds {
  return {
    asserted: ticketKey('FIN', 11),
    accruals: ticketKey('FIN', 12),
    bankReconciliation: ticketKey('FIN', 13),
    other: ticketKey('LOG', 7),
  };
}

/** The line of smoke.py the sandbox's traceback named. */
export const RECORDED_ASSERTION_LINE = 70;

/**
 * The assertion the verification log recorded, for a given id.
 *
 * Args:
 *   id: The ticket key the assertion names.
 *
 * Returns:
 *   The Python line, as the traceback printed it.
 */
export function recordedAssertion(id: string): string {
  return `assert run_a["actions"][2]["args"]["body"].count("${id}") == 0`;
}

/** The SKILL.md body on Mateo's `kanban-comment-and-close` row in the rehearsal's export. */
export const RECORDED_BODY_2026_09_18 = [
  "# kanban-comment-and-close",
  "",
  "Comment-and-close on a kanban ticket surface: post one audit comment on the ticket named by the work item, then — in the same response — move that ticket to the closing state. Every value comes from the run's inputs; nothing is constant.",
  "",
  "## When to invoke",
  "",
  "Invoke when a work item asks for a note, summary or status comment to be posted on a ticket on a kanban surface, and the runbook for that surface says the loop is closed by a comment followed by a state change on that same ticket. Preconditions:",
  "",
  "- The work item names a ticket on the kanban surface (the `Refs:` line or the candidate id gives `<record-id>`).",
  "- The candidate or its runbook names the text or figure to post (`<requested-value>`).",
  "- The runbook prescribes a read-back (`<audit-expectation>`) that serves as evidence the comment landed.",
  "- The surface is connected. If no connected surface covers the ticket's system, emit no actions and say so in `notes`.",
  "",
  "## Inputs",
  "",
  "- `<record-id>` — the ticket's identifier on the surface, read from the candidate's `Refs:` line or the candidate id. Used as the comment target and the state-change target.",
  "- `<requested-value>` — the comment body: the figure or text the candidate or the runbook names for this run. Never a constant in this skill.",
  "- `<closing-state>` — the exact workflow-state name to move the ticket to, as the runbook or the candidate names it for this run (for example the workspace's completed-state name discovered from the surface).",
  "- `<originating-surface>` — the slug of the connected surface the work came from, exactly as the Surfaces list names it.",
  "- `<audit-expectation>` — the read-back the runbook prescribes as evidence (an audit line, a returned identifier, a snapshot); stated under Verification.",
  "- `<reply-channel>` and `<reply-thread>` — the `Reply target:` line when the work came from a chat channel or thread. Only used to close the loop in chat; omit when the work came from the ticket surface itself.",
  "",
  "## Procedure",
  "",
  "1. Read `<record-id>`, `<requested-value>`, `<closing-state>` and `<originating-surface>` from the candidate, its `Refs:` line and its runbook. If any is missing, ask via the manager DM before emitting any action.",
  "2. Optionally read the ticket first (`get_issue` on the surface) to confirm the identifier exists and to discover the exact workflow-state name for `<closing-state>`. Never invent an id or a state name.",
  "3. Emit the audit comment as the first action:",
  "",
  "```json",
  "{",
  "  \"action\": \"mcp.call\",",
  "  \"surface\": \"<originating-surface>\",",
  "  \"tool\": \"save_comment\",",
  "  \"toolArgsJson\": \"{\\\"issueId\\\": \\\"<record-id>\\\", \\\"body\\\": \\\"<requested-value>\\\"}\"",
  "}",
  "```",
  "",
  "   Send `issueId` and `body` only. Never send `id` or `parentId` — those rewrite or reply to an existing comment. Never write a provenance trailer or `username`; the server appends the employee name and run id.",
  "",
  "4. Emit the state change as the second action, in the same response and only after the comment action:",
  "",
  "```json",
  "{",
  "  \"action\": \"mcp.call\",",
  "  \"surface\": \"<originating-surface>\",",
  "  \"tool\": \"save_issue\",",
  "  \"toolArgsJson\": \"{\\\"id\\\": \\\"<record-id>\\\", \\\"state\\\": \\\"<closing-state>\\\"}\"",
  "}",
  "```",
  "",
  "   The argument is `state`, not `status`. Do not change assignee, priority, labels or description. A partial result gets the comment but no state change — the ticket stays in progress.",
  "",
  "5. If the work came from a chat channel or thread, close the loop there with one `http.request` POST to `chat.postMessage` on the chat surface, `channel` set to `<reply-channel>` and `thread_ts` set to `<reply-thread>`, body summarising what was done. The manager DM carries only a one-line note of what was done, never a draft that belongs in the channel.",
  "",
  "6. Do not hardcode approval language: at execution time read the run mode and describe effects as emitted or held accordingly.",
  "",
  "## Verification",
  "",
  "Read back and confirm `<audit-expectation>`: the comment's returned identifier (or audit line) on `<record-id>`, and the ticket's state now reporting `<closing-state>`. If the read-back does not match, do not claim completion; report the mismatch via the manager DM and leave the ticket in its prior state.",
  "",
  "## Actions emitted",
  "",
  "Exactly two `mcp.call` actions on `<originating-surface>` — `save_comment` then `save_issue` — plus, when a `Reply target:` line exists, one `http.request` `chat.postMessage` to the source channel and thread. A response with prose and no actions is broken.",
].join('\n');

/**
 * The failing smoke.py, reconstructed around the recorded assertion.
 *
 * Args:
 *   ids: The ticket keys to write into it.
 *
 * Returns:
 *   Python source whose line 70 is the recorded assertion.
 */
export function reconstructedSmokeTest(ids: RehearsalSmokeIds = rehearsalSmokeIds()): string {
  return [
    'import json',
    '',
    '',
    'def run(inputs: dict) -> dict:',
    '    record_id = inputs["record-id"]',
    '    note = inputs["requested-value"]',
    '    closing_state = inputs["closing-state"]',
    '    surface = inputs["originating-surface"]',
    '    actions = [',
    '        {',
    '            "tool": "mcp.call",',
    '            "args": {',
    '                "surface": surface,',
    '                "tool": "save_comment",',
    '                "toolArgsJson": json.dumps({"issueId": record_id, "body": note}),',
    '            },',
    '        },',
    '        {',
    '            "tool": "mcp.call",',
    '            "args": {',
    '                "surface": surface,',
    '                "tool": "save_issue",',
    '                "toolArgsJson": json.dumps({"id": record_id, "state": closing_state}),',
    '            },',
    '        },',
    '    ]',
    '    channel = inputs.get("reply-channel")',
    '    if channel:',
    '        text = f"{note}\\nStatus note posted on {record_id}; moved to {closing_state}."',
    '        actions.append(',
    '            {',
    '                "tool": "http.request",',
    '                "args": {',
    '                    "surface": "slack",',
    '                    "method": "POST",',
    '                    "path": "chat.postMessage",',
    '                    "headersJson": json.dumps({"Content-Type": "application/json"}),',
    '                    "body": json.dumps({"channel": channel, "thread_ts": inputs.get("reply-thread"), "text": text}),',
    '                },',
    '            }',
    '        )',
    '    return {"record": record_id, "state": closing_state, "actions": actions}',
    '',
    '',
    'case_a = {',
    `    "record-id": "${ids.asserted}",`,
    `    "requested-value": "Accruals booked: ${ids.accruals} Accruals booked for August, Done\\nBank reconciliation: ${ids.bankReconciliation} Bank reconciliation for August, In Progress\\nNot done yet: Bank reconciliation",`,
    '    "closing-state": "Done",',
    '    "originating-surface": "linear",',
    '    "reply-channel": "C0CLOSE",',
    '    "reply-thread": "1725000000.000100",',
    '    "audit-expectation": "the returned comment id on the ticket",',
    '}',
    'case_b = {',
    `    "record-id": "${ids.other}",`,
    '    "requested-value": "Exception recorded; carrier ETA confirmed.",',
    '    "closing-state": "Done",',
    '    "originating-surface": "linear",',
    '    "audit-expectation": "the returned comment id on the ticket",',
    '}',
    '',
    'run_a = run(case_a)',
    'run_b = run(case_b)',
    '',
    'assert len(run_a["actions"]) == 3',
    'assert len(run_b["actions"]) == 2',
    'assert run_a["actions"][0]["args"]["tool"] == "save_comment"',
    'assert run_a["actions"][1]["args"]["tool"] == "save_issue"',
    'assert json.loads(run_a["actions"][1]["args"]["toolArgsJson"])["state"] == "Done"',
    recordedAssertion(ids.asserted),
    'assert run_b["actions"][0]["args"]["tool"] == "save_comment"',
    '',
    'print(f"run-a: {len(run_a[\'actions\'])} actions, ticket {run_a[\'record\']} -> {run_a[\'state\']}")',
    'print(f"run-b: {len(run_b[\'actions\'])} actions, ticket {run_b[\'record\']} -> {run_b[\'state\']}")',
    'print("smoke ok")',
  ].join('\n');
}
