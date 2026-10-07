# Reading a Feishu or Lark wiki

This page is for two people: the IT administrator who creates the app day0 reads Feishu as, and
the manager who links the wiki on the Documentation page. day0 reads a Feishu (or Lark) wiki
space, or a Drive folder and the folders under it, and keeps each document as Markdown beside the
team's other documentation. It reads as the company's own app, never as a person, and it only
reads: it writes nothing to Feishu.

Feishu is the mainland China service at `open.feishu.cn`; Lark is the same product everywhere
else, at `open.larksuite.com`. A tenant is on one or the other, and a source names which.

## What day0 reads

- Every new-style document (`docx`) in the space or folder, as Markdown. Its title is its first
  `# ` heading, or the page's title in Feishu when it has none.
- Every other page is listed and named as not read, with the reason: a sheet, a base (bitable),
  a mind note, a slide deck, an uploaded file, and a document in the old format, which Feishu
  does not export as Markdown. A shortcut is not read twice: the page it points to is read where
  it lives.
- A document over 10 MB, the most Feishu exports as Markdown, is named as not read.
- A space or folder of more than 2,000 pages is refused: link a smaller space or folder.
- The source is read again on the same schedule as every other source. day0 waits between
  requests to stay inside Feishu's published limits (100 wiki listings a minute, 5 document reads
  a second) and, when Feishu still says it is busy, waits the time Feishu names before it asks
  again.

## 1. Create the app (IT)

1. Open the developer console: <https://open.feishu.cn/app> for Feishu, or
   <https://open.larksuite.com/app> for Lark. Create a **custom app** (企业自建应用) for your
   company, named so people recognise it, for example `day0 documentation`.
2. Under **Credentials & Basic Info**, note the **App ID** (it starts `cli_`) and the **App
   Secret**. The manager needs both to link the wiki. Treat the secret as a password.
3. Under **Permissions & Scopes**, add these read scopes and nothing else:

   | Scope                        | What day0 uses it for                            |
   | ---------------------------- | ------------------------------------------------ |
   | `wiki:wiki:readonly`         | Listing the wiki space's pages                   |
   | `docx:document:readonly`     | Reading each document's version                  |
   | `docs:document.content:read` | Reading each document as Markdown                |
   | `drive:drive:readonly`       | Listing a Drive folder, only for a folder source |

4. Under **Add Features**, add the **Bot** capability. The bot is how the app joins the wiki
   space (step 2); day0 sends no message through it.
5. Create a version and publish it. Its **availability** must include the wiki space's owner (or
   the folder's), or the space cannot add the app.

## 2. Let the app read the space (IT, or the space's administrator)

A wiki admits an app as a member through a group chat that has the app as its bot. This is
Feishu's own route (its wiki FAQ, "如何将应用添加为知识库管理员（成员）"):

1. In the Feishu client, create a group chat, for example `day0 documentation`, and add the app
   to it as the group's bot. Add the app itself, not a "custom bot".
2. In the wiki space, open **Settings**, then **Members**, and add that group chat as a member.
   Reading is enough; day0 needs no right to edit.

For a Drive folder instead of a wiki space, share the folder with the same group chat, with
permission to view.

To let the app read one document the space does not admit it to, open the document, then
**...**, **More**, **Add document app**, and choose the app.

## 3. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: Feishu or Lark wiki.
2. **Location label**: a name your team recognises, for example `RevOps wiki`.
3. **Where it is**: the wiki space's ID, or a link to the space or the folder. The space ID is
   the long number at the end of the address of the space's **Settings** page; a folder's link is
   its address in the browser. day0 keeps only the region's host and the space or folder, for
   example `https://open.feishu.cn/wiki/spaces/7300000000000000001`.
4. **Region**: Feishu (`open.feishu.cn`) or Lark (`open.larksuite.com`), whichever your company
   signs in to.
5. **App ID** and **App secret**: the two values from step 1. The secret is encrypted when you
   submit the form, sent only to Feishu, and never shown again.
6. **Link location**. The first read starts at once; the table shows its progress.

To replace the secret later (IT rotated it), use **Rotate** on the source's row and enter the app
ID and the new secret joined by a colon: `cli_...:secret`. **Revoke** removes the secret, and day0
stops reading the source until a new one is rotated in.

## What a page day0 cannot read shows

The source's row lists every page it could not read, each with its reason. These are the reasons
a Feishu source gives, word for word:

- `"Q3 numbers" is a Feishu sheet, which Day0 does not read: only documents (docx) are read, as
Markdown.` The same sentence names a base, a mind note, a slide deck, a file, or a document in
  the old format.
- `"Payroll" ...: add the app to the document, or to its wiki space as a member.` The full line is
  `The Feishu app cannot read "Payroll" (Feishu code 1770032): add the app to the document, or to
its wiki space as a member.` The page is in the space but the app may not open it: add the app
  to that document (step 2's last paragraph).
- `"Full CRM export" is larger than the 10 MB Feishu exports as Markdown, so it is not read.`
- `"..." was deleted or moved in Feishu after it was listed`: the next read lists the space again.

A page that could not be read keeps its last version in day0 until a later read succeeds.

When the whole source cannot be read, its status says why instead:

- `The Feishu app is not a member of this wiki space (Feishu code 131006): add a group chat that
has the app as its bot to the space's members.` Step 2 is not done, or the group was removed.
- `Feishu refused the app ID and secret this source was linked with ...; link it again with the
app's current secret.` The secret was rotated or the app was disabled: use **Rotate**.
- `Feishu was rate limited ...`: Feishu stayed busy past day0's waits; the next read carries on
  where this one stopped.

## For the network

The backend reaches `open.feishu.cn` for a Feishu source and `open.larksuite.com` for a Lark
source, over HTTPS, and no other Feishu host. `pnpm check:setup` lists both in its egress list.

## Not yet checked against a real tenant

day0's Feishu reader is built and tested against Feishu's published API reference (read 8 October 2026) and recorded responses in that shape; it has not yet read a real tenant. Two things are
known only from that reference until it does: that a wiki admits the app through the group chat
as described, and what Feishu answers for a document the app may not open; and whether Lark's
host serves the Markdown export, which its reference does not yet publish. A first install that
finds either different should say so.
