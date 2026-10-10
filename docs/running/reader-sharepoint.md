# Reading a SharePoint site

This page is for the IT administrator who registers the app day0 reads with and grants it the
site, and the manager who links the site on the Documentation page. day0 reads one SharePoint
site through Microsoft Graph and keeps each document as Markdown beside the team's other
documentation. It reads as the app, never as a person, and it only reads: it writes nothing to
SharePoint.

## What day0 reads

- In the site's document library: every **Markdown file** (`.md`), as it is, and every **Word
  document** (`.docx`), converted to Markdown where day0 runs. A Word document's headings (made
  with Word's heading styles), lists, tables and emphasis are kept; its pictures are left out.
  Its title is its file's name.
- The site's own **pages** (modern pages): the text web parts of each, in reading order, under
  the page's title.
- A page that is checked out or was never published is read and marked a **draft**, so an
  employee does not act on it. A file deleted from the library is marked **archived**, and
  nothing of its text is kept.
- These are named as not read, with the reason: a slide deck, a PDF, a Word document in the old
  `.doc` format, a Markdown file over 2 MiB, a Word document over 16 MiB, one protected with a
  password, and one that holds only pictures. Any other file (an image, a spreadsheet) is passed
  over and not listed.
- The site is read again on the same schedule as every other source. When Graph says it is busy
  (HTTP 429), day0 waits the time Graph names before it asks again.

## 1. Register the app and grant it the site (IT)

1. In the **Microsoft Entra admin centre**, register an application for day0 (single tenant).
   Note the **Directory (tenant) ID** and the **Application (client) ID**.
2. Under **Certificates & secrets**, create a **client secret**. Copy its value: it is shown
   once. Note its expiry; day0 stops reading the site when it lapses, until a new one is rotated
   in.
3. Under **API permissions**, add Microsoft Graph **application** permissions and grant admin
   consent. Graph's own reference lists, for each call day0 makes, this permission as the least
   one:

   | What day0 does                   | Graph call                            | Application permission the reference lists |
   | -------------------------------- | ------------------------------------- | ------------------------------------------ |
   | Finds the site by its address    | `GET /sites/{hostname}:/{path}`       | `Sites.Read.All`                           |
   | Walks the document library       | `GET /sites/{id}/drive/root/delta`    | `Files.Read.All` (or `Sites.Read.All`)     |
   | Downloads a file                 | `GET /drives/{id}/items/{id}/content` | `Files.Read.All` (or `Sites.Read.All`)     |
   | Lists and reads the site's pages | `GET /sites/{id}/pages/...`           | `Sites.Read.All`                           |

   So **`Sites.Read.All` alone covers every call**, and lets the app read every site in the
   tenant.

4. **To limit the app to this one site**, grant `Sites.Selected` instead and then give the app
   the site: a SharePoint administrator assigns the app the `read` role on the site (through
   Graph's site permissions, which needs `Sites.FullControl.All` for whoever assigns it, or with
   PnP PowerShell's `Grant-PnPAzureADAppSitePermission`). **This is not yet confirmed**: Graph's
   reference does not list `Sites.Selected` for the library walk or for the pages, so whether a
   site grant reaches those two calls is to be confirmed on the first tenant. If day0's status
   then says Graph refused a call, grant `Sites.Read.All` knowingly, or tell the day0
   maintainers what it said.

## 2. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: SharePoint site.
2. **Location label**: a name your team recognises, for example `Runbooks site`.
3. **Where it is**: the site's address, or the address of any library or page in it, as your
   browser shows it. day0 keeps only the site, for example
   `https://acme.sharepoint.com/sites/Runbooks`.
4. **Tenant ID**, **Client ID** and **Client secret**: the three values from step 1. The secret
   is encrypted when you submit the form, sent only to Microsoft, and never shown again.
5. **Link location**. The first read starts at once; the table shows its progress.

To replace the secret later, use **Rotate** on the source's row and enter the three values
joined by colons (`tenant ID:client ID:client secret`, no spaces). To change the site, **Unlink**
the source and link it again.

## What a page day0 cannot read shows

The source's row names up to ten of the pages it did not read, each with its reason, those a read
failed on first. These are the reasons a SharePoint source gives, word for word:

- `"Q3 board deck.pptx" is a slide deck, which Day0 does not read: from a SharePoint library it
reads Markdown files, Word documents (.docx) and the site's own pages.` The same sentence names a
  PDF, or a Word document in the old .doc format.
- `"full-crm-export.md" is 5 MiB, larger than the 2 MiB Day0 reads of one file.`
- `"Policy binder.docx" is 40 MiB, larger than the 16 MiB Day0 reads of one Word document.`
- `"Escalation paths.docx" is not read: it is not a .docx file Day0 can open: it may be protected
with a password, or be an older .doc saved under the newer name.`
- `"Escalation paths.docx" has no text Day0 can read: it may hold only pictures.`
- `"..." was deleted or moved in SharePoint after it was listed.`

When the whole site cannot be read, its status says why:

- `Microsoft refused the app registration this source reads as (invalid_client, AADSTS7000215):
its client secret may have expired or been replaced. Ask IT for the registration's tenant ID,
client ID and current client secret, then use Rotate on the source's row to enter them as tenant
ID:client ID:client secret.`
- `Microsoft Graph refused the app this call (HTTP 403, accessDenied): reading the site's document
library needs the application permission Files.Read.All, or Sites.Read.All, with admin consent.
Ask IT to check the app registration against reader-sharepoint.md; where it was given
Sites.Selected alone, ask them to confirm the site was granted to the app, or to grant
Sites.Read.All.` The same sentence names the site lookup or the pages, with the permission each
  needs. Step 1, points 3 and 4.
- `Microsoft Graph found no SharePoint site at acme.sharepoint.com/sites/Nowhere (HTTP 404): ...`
- `Microsoft Graph was rate limited (HTTP 429).` Graph stayed busy past day0's waits; the next
  read tries again.
- `Day0 could not reach graph.microsoft.com: ...` Nothing answered at that host from the machine
  the backend runs on. See the next section.

## For the network

The backend reaches, over HTTPS: `login.microsoftonline.com` (the app's sign-in),
`graph.microsoft.com` (Microsoft Graph), and, to download a file, the address Graph names for
it, which is on your own `<tenant>.sharepoint.com`. In real mode `pnpm check:setup` lists the
first two in its egress list. The backend connects directly: it uses no HTTP proxy.

**The cloud 21Vianet operates in China.** A site whose address ends in `sharepoint.cn` is read
through that cloud's hosts instead, which Microsoft's national cloud page names:
`login.chinacloudapi.cn` and `microsoftgraph.chinacloudapi.cn`. This is a documented option
that no tenant has checked; Microsoft's Entra documentation names a second sign-in host for that
cloud (`login.partner.microsoftonline.cn`), and which of the two a tenant answers at is to be
confirmed on the first one.

## Not yet checked against a real tenant

The reader is built against Microsoft Graph's published reference (read 10 October 2026), with
test answers written from that reference, not recorded from a tenant: **no tenant read yet**.
Until one is, these are known only from the reference: whether a `Sites.Selected` grant reaches
the library walk and the pages; the hosts of the 21Vianet cloud; the host a file's download
address is on; what a page's publishing state says (the reference documents `published` and
`checkout`, and its example answers `draft`; day0 reads anything but `published` as a draft);
and whether a library's first walk lists the files in its recycle bin. If a first install finds
any of them different, tell the day0 maintainers so this page can say what is true.
