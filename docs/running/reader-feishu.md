# Reading a Feishu or Lark wiki

This page is for three people: the IT administrator who creates the Feishu app that day0 reads
with, the wiki administrator who lets that app into the wiki, and the manager who links the wiki
on the Documentation page. day0 reads a Feishu (or Lark) wiki space, or a Drive folder and the
folders under it, and keeps each document as Markdown beside the team's other documentation. It
reads as the company's own app, never as a person, and it only reads: it writes nothing to
Feishu.

Feishu is the mainland China service at `open.feishu.cn`; Lark is the same product everywhere
else, at `open.larksuite.com`. A company is on one or the other: on Lark if its Feishu address
ends in `larksuite.com`, on Feishu if it ends in `feishu.cn`.

## What day0 reads

- Every new-style document (`docx`) in the space or folder, as Markdown. Its title is its first
  `# ` heading, or the page's title in Feishu when it has none.
- Every other page is listed and named as not read, with the reason: a sheet, a base (bitable),
  a mind note, a slide deck, an uploaded file, and a document in the old format, which Feishu
  does not export as Markdown. A shortcut is not read twice: the page it points to is read where
  it lives, if that is in the same space or folder.
- A document over 10 MB, the most Feishu exports as Markdown, is named as not read.
- A source of more than 2,000 pages and folders is refused. A wiki space is linked whole, so a
  larger one is linked as a Drive folder of the pages that matter instead.
- The source is read again on the same schedule as every other source. day0 waits between
  requests to stay inside Feishu's published limits (100 wiki listings a minute, 5 document reads
  a second) and, when Feishu still says it is busy, waits the time Feishu names before it asks
  again.

## 1. Create the app (IT)

The menu names below are those of Feishu's English developer console at the time of writing;
the Chinese console names each step differently.

1. Open the developer console: <https://open.feishu.cn/app> for Feishu, or
   <https://open.larksuite.com/app> for Lark. Create a **custom app** (企业自建应用) for your
   company, named so people recognise it, for example `day0 documentation`.
2. Under **Credentials & Basic Info**, note the **App ID** (it starts `cli_`) and the **App
   Secret**. The manager needs both to link the wiki. Treat the secret as a password.
3. Under **Permissions & Scopes**, add these read scopes and nothing else, and save them:

   | Scope                        | What day0 uses it for                            |
   | ---------------------------- | ------------------------------------------------ |
   | `wiki:wiki:readonly`         | Listing the wiki space's pages                   |
   | `docx:document:readonly`     | Reading each document's details                  |
   | `docs:document.content:read` | Reading each document as Markdown                |
   | `drive:drive:readonly`       | Listing a Drive folder, only for a folder source |

4. Add the **Bot** capability (in the Chinese console, 添加应用能力, then the bot card, then
   **+ Add**). The bot is how the app joins the wiki space (step 2); day0 sends no message
   through it.
5. Create a version and publish it. Its **availability** must include the wiki space's owner (or
   the folder's), or the space cannot add the app.

## 2. Let the app read the space (a wiki administrator)

A wiki admits an app as a member through a group chat that has the app as its bot. This is
Feishu's own route (its wiki FAQ, "如何将应用添加为知识库管理员（成员）"), and only a wiki
administrator can take its second step:

1. In the Feishu client, create a group chat, for example `day0 documentation`, and add the app
   to it as the group's bot. Add the app itself, not a "custom bot".
2. In the wiki space, open **Settings**, then **Members**, and add that group chat as a member
   that can read. day0 needs no right to edit.

To let the app read one document the space does not admit it to, a person who may manage that
document (its owner, a collaborator with manage rights, or a wiki administrator) opens it, then
**...**, **More**, **Add document app**, and chooses the app. The app is offered there only once
step 1's scopes are saved.

## 3. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: Feishu or Lark wiki or folder.
2. **Location label**: a name your team recognises, for example `RevOps wiki`.
3. **Where it is**: the wiki space's ID, or a Drive folder's address as your browser shows it.
   The space ID is the number at the end of the address of the space's **Settings** page; only a
   wiki administrator can open that page, so ask one for it if that is not you. The address of a
   single wiki page does not work. day0 keeps only the region's host and the space or folder, for
   example `https://open.feishu.cn/wiki/spaces/7300000000000000001`.
4. **Region**: Feishu (`open.feishu.cn`) or Lark (`open.larksuite.com`). A pasted Feishu or Lark
   address names its own region, whatever this field says.
5. **App ID** and **App secret**: the two values from step 1. The secret is encrypted when you
   submit the form, sent only to Feishu or Lark, and never shown again.
6. **Link location**. The first read starts at once; the table shows its progress.

To replace the secret later (IT rotated it), use **Rotate** on the source's row, enter the app ID
and the new secret joined by a colon (`cli_...:secret`, no spaces), then **Save**. **Revoke**
removes the secret, and day0 stops reading the source until a new one is rotated in.

## What a page day0 cannot read shows

The source's row counts every page it did not read and names up to ten of them, each with its
reason. A page a read failed on (the app may not open it, it is too large, it was deleted) is
named ahead of a page of a kind day0 does not read (a sheet, a base, a mind note), so the
sheets in a wiki never hide the one document that needs someone's attention; the rest are
counted as "and N more". Only a page a read failed on is said to be read again at the next sync.
These are the reasons a Feishu source gives, word for word:

- `"Q3 numbers" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as
Markdown.` The same sentence names a base, a mind note, a slide deck, a file, or a document in
  the old format.
- `"Handbook" is a shortcut, which day0 does not read twice: the page it points to is read where
it lives, if that is in this source.`
- `The Feishu app cannot read "Payroll" (Feishu code 2889902): add the app to the document, or to
its wiki space as a member.` The page is in the space but the app may not open it: add the app
  to that document (step 2's last paragraph).
- `"Full CRM export" is larger than the 10 MB Feishu exports as Markdown, so it is not read.`
- `"..." was deleted or moved in Feishu after it was listed`: the next read lists the space again.
- `Feishu could not give "..." as Markdown (Feishu code ..., ...). Re-sync to try again; if it
repeats, ask IT to look the code up in Feishu's documentation.`

- `Feishu answered HTTP 500 for "..." each time it was asked (Feishu code ...); re-sync to try
again.` Feishu failed on that document through every retry; the rest of the source was read.

A page a read failed on keeps its last version in day0 until a later read succeeds.

When the whole source cannot be read, its status says why instead:

- `The Feishu app is not a member of this wiki space, or may not read its pages (Feishu code
131006): add a group chat that has the app as its bot to the space's members.` Step 2 is not
  done, or the group was removed.
- `Feishu found no wiki space with this ID (Feishu code 131005): check the space ID.`
- `Feishu refused the app ID and secret this source uses (...): use Rotate on the source's row to
enter the app's current ID and secret.` The secret was rotated or the app was disabled. The
  sentence goes on to name the region this source asks: **Rotate** changes the ID and secret,
  never the region. If the app was made on Lark and the source was linked as Feishu (or the other
  way round), **Unlink** the source and link it again with the right region.
- `Feishu refused the request as this app (...): check that the app has the scopes reader-feishu.md
lists and that its latest version is published.` A scope from step 1 is missing, or the version
  that added it was never published.
- `Feishu was rate limited ...`: Feishu stayed busy past day0's waits; the next read tries again.
- `Day0 could not reach open.feishu.cn: ...`: nothing answered at Feishu's host from the machine
  the backend runs on (a firewall, or a name that does not resolve there). See the next section.

## For the network

The backend reaches `open.feishu.cn` for a Feishu source and `open.larksuite.com` for a Lark
source, over HTTPS, and no other Feishu host. In real mode, `pnpm check:setup` lists both in its
egress list. The backend connects to them directly: it uses no HTTP proxy, so a network that
allows outbound HTTPS only through a proxy must allow these two hosts for the machine day0 runs
on.

## Not yet checked against a real tenant

day0's Feishu reader is built and tested against Feishu's published API reference (read 8 October 2026), with test answers written from that reference, not recorded from a tenant; it has not yet read a real tenant. Four things are
known only from that reference until it does: that a wiki admits the app through the group chat
as described; what Feishu answers for a document the app may not open; how a Drive folder is
shared with the app (the reference does not say; sharing it with the same group chat, with
permission to view, is the expected route); and whether Lark's host serves the Markdown export,
which Lark's reference does not publish. If a first install finds any of them different, tell the
day0 maintainers so this page can say what is true.
