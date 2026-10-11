# Reading a Google Drive folder

This page is for the IT administrator who makes the service account day0 reads with, the
folder's owner who shares the folder with it, and the manager who links the folder on the
Documentation page. day0 reads one Google Drive folder and the folders under it, and keeps each
document as Markdown beside the team's other documentation. It reads as a service account,
never as a person, and it only reads: it writes nothing to Drive.

A folder can also be read through a Google Drive MCP server the company already runs (the **MCP
server** kind). Use one or the other for a folder, not both.

## What day0 reads

- Every **Google Doc** in the folder and the folders under it, exported by Google as Markdown,
  under the document's name.
- Every **Word document** (`.docx`), converted to Markdown where day0 runs: its headings (made
  with Word's heading styles), lists, tables and emphasis are kept, its pictures left out.
- A document in the **bin** is read and marked archived, so an employee does not act on it. When
  Google empties the bin, day0 drops it.
- These are named as not read, with the reason: a Google Doc over the 10 MB Google exports, a
  Word document over 16 MiB, a slide deck, a PDF and a Word document in the old `.doc` format.
  Any other file (a sheet, an image) is not listed.
- The service account sees only what is shared with it. A document in the folder that its owner
  has restricted is simply not there for day0.
- The folder is read again on the same schedule as every other source. When Google says a rate
  limit is reached (HTTP 403 `userRateLimitExceeded` or `rateLimitExceeded`, or HTTP 429), day0
  waits one, two, then four seconds before it asks again.

## 1. Create the service account (IT)

1. In the **Google Cloud console**, in a project of your organisation, enable the **Google
   Drive API** (APIs and services, Library).
2. Create a **service account** for day0 (IAM and admin, Service accounts). It needs no role in
   the project. Do **not** give it domain-wide delegation: day0 does not use it.
3. For the service account, create a **key** of type JSON (Keys, Add key). The browser downloads
   a `.json` file. Treat it as a password: the manager pastes its contents once, and it can then
   be deleted.
4. Note the service account's address (`...@<project>.iam.gserviceaccount.com`).

## 2. Share the folder (the folder's owner)

Share the folder with the service account's address as a **Viewer**. Everything in the folder
and the folders under it is then shared with it, unless a document's own sharing says otherwise.

## 3. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: Google Drive folder.
2. **Location label**: a name your team recognises, for example `Runbooks folder`.
3. **Where it is**: the folder's address as your browser shows it. day0 keeps only the folder,
   for example `https://drive.google.com/drive/folders/1AbCdEf...`.
4. **Service account key**: paste the whole contents of the JSON file from step 1. It is
   encrypted when you submit the form, used only to sign day0's requests to Google, and never
   shown again.
5. **Link location**. The first read starts at once; the table shows its progress.

To replace the key later, use **Rotate** on the source's row and paste the new JSON file's
contents. To change the folder, **Unlink** the source and link it again.

## What a page day0 cannot read shows

- `"Full CRM export" is larger than the 10 MB Google exports, so Day0 does not read it.`
- `"Q3 board deck" is a slide deck, which Day0 does not read: from a Google Drive folder it reads
Google Docs and Word documents (.docx).` The same sentence names a PDF, or a Word document in
  the old .doc format.
- `Google Drive would not give "..." (HTTP 403, cannotExportFile). Re-sync to try again; if it
repeats, ask the document's owner whether viewers may download it.` The owner has stopped viewers
  downloading the document.
- `"..." was deleted or moved in Google Drive after it was listed.`

When the whole folder cannot be read, its status says why:

- `Google Drive found no folder at this address that the service account may read (HTTP 404):
share the folder with day0-reader@acme-docs.iam.gserviceaccount.com as a Viewer, and check the
address. To change the address, unlink the source and link it again.` Step 2 is not done. The
  sentence names your own service account's address.
- `Google refused the service account key this source uses (invalid_grant): the key may have been
deleted, or the service account disabled. Ask IT to create a new JSON key for ... in Google
Cloud, then use Rotate on the source's row to paste it.`
- `Google Drive refused this request (HTTP 403, accessNotConfigured): the Google Drive API is not
enabled in the service account's Google Cloud project. Ask IT to enable it there (APIs and
services, Library, Google Drive API).` Step 1, point 1.
- `Google Drive was rate limited (HTTP 403).` Google stayed over its limit past day0's waits; the
  next read tries again.
- `Day0 could not reach www.googleapis.com: ...` Nothing answered at that host from the machine
  the backend runs on. See the next section.

## For the network

The backend reaches `oauth2.googleapis.com` (for the service account's token) and
`www.googleapis.com` (the Drive API), over HTTPS, and no other Google host. In real mode
`pnpm check:setup` lists both in its egress list. The backend connects directly: it uses no HTTP
proxy.

## Not yet checked against a real project

The reader is built against Google's published reference for the Drive API and for service
accounts (read 10 October 2026), with test answers written from that reference, not recorded
from a project: **no tenant read yet**. Until one is, these are known only from the reference:
the word Google gives an export over 10 MB; whether a folder in a shared drive lists as one in
My Drive does; and how Google's Markdown export writes a document's own title. If a first
install finds any of them different, tell the day0 maintainers so this page can say what is
true.
