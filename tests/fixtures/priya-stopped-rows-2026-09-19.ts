/**
 * The 19 Sep fourth full run's stopped row of Priya's (finding U), as
 * `findings/priya-stopped-rows-0951.jsonl` kept it: the `#ops-requests` ask.
 * Eight actions landed (the tile sign-in, the fill, Save, the audit-line
 * snapshot, `list_issues`, the thread reply); the ninth, the closing set's
 * read-back `GET /conversations.replies` with its parameters in a JSON body,
 * was refused as an unattributable write and the run stopped. Values are
 * verbatim from the row; only each ledger `effect` is cut at 300 characters.
 */
import type { MockAction } from '../../src/work/types';

export const OPS_REQUESTS_ASK = {
  "workItemId": "nh7b00enckkbxthyj1tb2ab8k98eqjzb",
  "title": "Slack mention in #ops-requests",
  "externalId": "C0C2U2UJUTU:1789761553.312049",
  "skipReason": "stopped: Day0's gate refused 1 of 9 actions before sending it, so the steps that needed it were not done; the other 8 landed and stay as they are. Refused: GET /conversations.replies on slack (refused before sending: under the shared credential this write would carry nothing naming the employee or the run. A new ticket needs a title and a description for Day0 to sign; a change to an existing ticket needs an audit comment on it first). Retry with a note that changes the step, or do it by hand",
  "actions": [
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_navigate",
        "toolArgsJson": "{\"url\":\"http://looker-tile:8080/\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_fill_form",
        "toolArgsJson": "{\"fields\":[{\"name\":\"Username\",\"value\":\"revops\"},{\"name\":\"Password\",\"value\":\"{{secret}}\"}]}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_click",
        "toolArgsJson": "{\"element\":\"Sign in\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_fill_form",
        "toolArgsJson": "{\"fields\":[{\"name\":\"Pipeline coverage\",\"value\":\"74%\"}]}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_click",
        "toolArgsJson": "{\"element\":\"Save\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "looker-pipeline-tile",
        "tool": "browser_snapshot",
        "toolArgsJson": "{}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "surface": "linear",
        "tool": "list_issues",
        "toolArgsJson": "{\"team\":\"REVOPS\",\"project\":\"Q3 close\",\"query\":\"Refresh the Looker pipeline tile\"}"
      },
      "tool": "mcp.call"
    },
    {
      "args": {
        "body": "{\"channel\":\"C0C2U2UJUTU\",\"thread_ts\":\"1789761553.312049\",\"text\":\"Refreshed the pipeline tile to the standup figure, 74% (ask: C0C2U2UJUTU:1789761553.312049). Audit line: Last updated by revops at 2026-09-19 01:49:00 UTC. REVOPS-27 (Refresh the Looker pipeline tile) has its own work item; the audit note with this evidence will be posted there.\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "POST",
        "path": "/chat.postMessage",
        "surface": "slack"
      },
      "tool": "http.request"
    },
    {
      "args": {
        "body": "{\"channel\":\"C0C2U2UJUTU\",\"thread_ts\":\"1789761553.312049\"}",
        "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
        "method": "GET",
        "path": "/conversations.replies",
        "surface": "slack"
      },
      "tool": "http.request"
    }
  ],
  "applied": [
    {
      "authority": "autonomous",
      "effect": "browser_navigate on looker-pipeline-tile · ### Ran Playwright code ```js await page.goto('http://looker-tile:8080/'); ``` ### Page - Page URL: http://looker-tile:8080/ - Page Title: Sign in - Looker ### Snapshot - [Snapshot](.playwright-mcp/page-2026-09-19T01-48-56-724Z.yml)",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:0",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_fill_form on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Username' }).fill('revops'); await page.getByRole('textbox', { n…",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:1",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_click on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Sign in' }).click(); ``` ### Page - Page URL: http://looker-tile:8080…",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:2",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_fill_form on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Pipeline coverage' }).fill('74%'); ```",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:3",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_click on looker-pipeline-tile · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Save' }).click(); ``` ### Page - Page URL: http://looker-tile:8080/ti…",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:4",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "browser_snapshot on looker-pipeline-tile · visible figure 74% · Last updated by revops at 2026-09-19 01:49:00 UTC",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:5",
      "ok": true,
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "list_issues on linear · {\"issues\":[{\"id\":\"REVOPS-27\",\"uuid\":\"38a1207a-13ee-4ef6-b5bd-fe7ef77c9f79\",\"title\":\"Refresh the Looker pipeline tile\",\"description\":\"Update the pipeline coverage figure on the Looker pipeline tile to the figure in the Friday standup coverage summary.\\n\\nday0-demo-key: revops-",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:6",
      "ok": true,
      "providerId": "REVOPS-27",
      "tool": "mcp.call"
    },
    {
      "authority": "autonomous",
      "effect": "HTTP 200 · {\"ok\":true,\"channel\":\"C0C2U2UJUTU\",\"ts\":\"1789782641.120049\",\"message\":{\"subtype\":\"bot_message\",\"text\":\"Refreshed the pipeline tile to the standup figure, 74% (ask: C0C2…",
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:7",
      "ok": true,
      "providerId": "1789782641.120049",
      "tool": "http.request"
    },
    {
      "idempotencyKey": "nh7b00enckkbxthyj1tb2ab8k98eqjzb:k972h79krrtrhjzg6s7qt62ca58ep41c:8",
      "ok": false,
      "reason": "refused before sending: under the shared credential this write would carry nothing naming the employee or the run. A new ticket needs a title and a description for Day0 to sign; a change to an existing ticket needs an audit comment on it first",
      "tool": "http.request"
    }
  ],
  "replyTarget": {
    "channel": "C0C2U2UJUTU",
    "channelName": "ops-requests",
    "threadTs": "1789761553.312049"
  }
};

export const OPS_REQUESTS_ASK_ACTIONS = OPS_REQUESTS_ASK.actions as MockAction[];
