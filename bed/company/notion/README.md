# The Notion pages, pasted by hand

The company bed's documentation comes from two sources: the folder `bed/company/folder/`, which
`pnpm bed:company docs` copies into `docs-local/`, and the two pages in this directory, which you
paste into Notion once, by hand. Nothing here is a secret; the one token line stays a placeholder
in git and is filled in Notion only.

## Paste them

1. In your Notion workspace, create a page titled `Kestrel Supply handbook`. It is the parent; leave
   its body empty, and Notion lists the two pages under it.
2. Under it, create one page per file below. Paste the file's text as the page body, and make the
   page title the file's first `# ` heading:

   | File | Notion page title |
   |---|---|
   | `linear-automation.md` | Linear automation |
   | `slack-automation-policy.md` | Slack automation policy |

3. On `Linear automation`, replace `PASTE_LINEAR_API_KEY_HERE` with the Linear personal API key the
   company automation uses: the same key as `DAY0_BED_LINEAR_API_KEY` in `.env.local`. Nothing else
   on either page changes, and the Slack page carries no token at all.
4. Share the parent with your Notion internal integration (the parent's `...` menu, Connections).
   The two pages inherit the connection.
5. Take the integration off every other page, an earlier handbook parent included. Documentation
   sync reads every page the integration can see.

`pnpm bed:company check` then reads the pages through the bundled Notion component, the way the
backend will, and says which page differs from this directory (the token line apart), which is
missing, and which page the integration can see that is not one of these three.

## What documentation sync then reads

Three Notion pages: the parent, whose body is the list of its two pages, and the two pages. The
Linear token is stored encrypted on the first sync and replaced on the stored page by a credential
marker.

## Link the source

On `/documentation`, link a source of kind `mcp`, server kind `Notion`, location
`http://docs-notion-mcp:3000/mcp`, with the integration's secret in the password field. The folder
source is linked beside it as kind `folder`, location `.`.
