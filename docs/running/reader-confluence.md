# Reading a Confluence space

This page is for the IT administrator who makes the credential day0 reads with, and the manager
who links the space on the Documentation page. day0 reads one Confluence space and keeps each
page as Markdown beside the team's other documentation. It only reads: it writes nothing to
Confluence. There are two kinds, one for each Confluence:

- **Confluence Cloud** (`<your site>.atlassian.net`): day0 reads as a **service account**, with a
  scoped API token, through Atlassian's gateway at `api.atlassian.com`.
- **Confluence Data Center** (your own server): day0 reads with a **personal access token**, at
  your server's own address. Atlassian ends Data Center on **28 March 2029**: no new Data Center
  subscription has been sold since 30 March 2026, an existing customer may add to theirs until
  30 March 2028, and after 28 March 2029 the product is read-only. Plan the move to Cloud inside
  that time; day0 reads either.

A space can also be read through Atlassian's MCP server (the **MCP server** kind). Use one or the
other for a space, not both.

## What day0 reads

- Every page of the space, converted from Confluence's storage format to Markdown under the
  page's own title: headings, lists, tables, code blocks (with their language), information
  panels, task lists, links to other pages (as their words) and dates. A macro that only lists
  other content (a table of contents, a page tree) draws nothing. An attached image is named by
  its file; an included page is read as its own page, not repeated inside the page that includes
  it.
- A page's version number is kept as its revision.
- An **archived** page is read and marked archived, so an employee does not act on it. On Data
  Center this depends on the server listing its archived pages, which Atlassian's reference does
  not say it does: where it does not, archived pages are simply not read.
- A page Confluence gives no body for is named as not read.
- The space is read again on the same schedule as every other source. When Confluence says it is
  busy (HTTP 429, or 503), day0 waits the time Confluence names before it asks again.

## 1a. Confluence Cloud: the service account (IT)

1. In **Atlassian Administration** (`admin.atlassian.com`), create a **service account** for
   day0, and give it access to Confluence.
2. In the space, give the service account **View** permission. day0 needs no other.
3. For the service account, choose **Create credentials**, then **API token**. Name it, set its
   expiry (a token lasts at most 365 days, so note when to replace it), and choose these scopes
   and no others:

   | Scope                   | What day0 uses it for                 |
   | ----------------------- | ------------------------------------- |
   | `read:space:confluence` | Finding the space by its key          |
   | `read:page:confluence`  | Listing and reading the space's pages |

4. Copy the token: Atlassian shows it once.
5. Note the site's **cloud ID**: in `admin.atlassian.com`, it is the string after `/s/` in the
   address. It is not the organisation ID; with the organisation ID every request answers 404.

## 1b. Confluence Data Center: the token (IT)

1. Choose an account that may view the space (a dedicated one is better than a person's).
2. Signed in as that account, open the profile picture, **Settings**, **Personal access tokens**,
   and create a token. Copy it: Confluence shows it once. Personal access tokens need Confluence
   7.9 or later.
3. The backend must reach the server over **HTTPS**. A server inside your network, on a private
   address, is read only when its host is listed in `DAY0_PRIVATE_HOSTS` in `.env.local` (then
   `./scripts/sync-convex-env.sh`). A server whose certificate comes from your own certificate
   authority needs that authority's bundle in the backend (`NODE_EXTRA_CA_CERTS`, in
   [install.md](install.md)).
4. If a sign-in page (single sign-on) stands in front of Confluence, it must let a request with
   a personal access token through to `/rest/api` without redirecting it.

## 2. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: Confluence Cloud space, or Confluence Data Center space.
2. **Location label**: a name your team recognises, for example `Operations wiki`.
3. **Where it is**: for Cloud, the space's key (`OPS`) or its address as your browser shows it;
   for Data Center, the space's address on your server
   (`https://wiki.acme.corp/display/OPS`). day0 keeps only the space: for Cloud,
   `https://api.atlassian.com/ex/confluence/<cloud ID>/wiki/spaces/OPS`.
4. For Cloud, **Cloud ID** and **API token**; for Data Center, **Personal access token**. The
   token is encrypted when you submit the form, sent only to Atlassian (Cloud) or to your own
   server (Data Center), and never shown again.
5. **Link location**. The first read starts at once; the table shows its progress.

To replace the token later, use **Rotate** on the source's row. To change the space, the cloud
ID or the server's address, **Unlink** the source and link it again: Rotate changes the token
only.

## What a source that cannot be read shows

A page day0 does not read is named on the source's row with its reason:

- `Confluence gave no body in its storage format for "Quarter board", so Day0 does not read it.`

When the whole space cannot be read, its status says why. On Confluence Cloud:

- `Confluence refused the API token this source uses (HTTP 401): it may have expired (a token
lasts a year at most) or been revoked. Ask IT to create a new API token for the service account
with the scopes reader-confluence.md lists, then use Rotate on the source's row to enter it.`
- `Confluence refused this request for the service account (HTTP 403): ask IT to check that its
API token has the scopes reader-confluence.md lists (read:space:confluence and
read:page:confluence), that the service account has access to Confluence, and that it may view
the space.`
- `Atlassian found no Confluence site with this cloud ID (HTTP 404): ...` The location holds the
  organisation ID, or a mistyped cloud ID.
- `Confluence found no space with the key "OPS" that the service account may view: check the key,
and ask IT to give the service account View permission in the space.`

On Confluence Data Center:

- `Confluence refused the personal access token this source uses (HTTP 401): it may have expired
or been revoked. Ask the person it belongs to to create a new one in Confluence (their profile
picture, Settings, Personal access tokens), then use Rotate on the source's row to enter it.`
- `Confluence refused this request for the token's owner (HTTP 403): ask a space administrator to
give that person View permission in the space OPS.`
- `Confluence found no space with the key "OPS" at https://wiki.acme.corp that the token's owner
may view (HTTP 404): ...` The address is wrong, or lacks the server's context path.
- `wiki.acme.corp answered with a redirect (HTTP 302) where its REST API should answer, which is
what a sign-in page in front of Confluence does: ...` Step 1b's last point.
- `... names a host inside a private network that DAY0_PRIVATE_HOSTS does not list, so Day0 does
not read it.` Step 1b's third point.

On either:

- `Confluence was rate limited (HTTP 429).` Confluence stayed busy past day0's waits; the next
  read tries again.
- `Day0 could not reach api.atlassian.com: ...` Nothing answered at that host from the machine
  the backend runs on. See the next section.
- `api.atlassian.com answered HTTP 403 with a page that is not Confluence's own answer, ...` A
  proxy or a firewall answered in Confluence's place.

## For the network

For Confluence Cloud the backend reaches `api.atlassian.com` over HTTPS and no other Atlassian
host; in real mode `pnpm check:setup` lists it in its egress list. For Data Center it reaches
your own server, which that list cannot name. The backend connects directly: it uses no HTTP
proxy.

## Not yet checked against a real site

Both readers are built against Atlassian's published reference (the Confluence Cloud REST API
v2 specification and the Confluence Data Center REST reference for 8.9.3, read 10 October 2026),
with test answers written from that reference, not recorded from a site: **no tenant read yet**.
Until one is, these are known only from the reference: that a service account's scoped token
reads a space as described; what Atlassian's gateway answers for a wrong token or cloud ID; the
shapes of the macros in a page's storage format beyond the common ones; and whether a Data
Center server lists its archived pages. If a first install finds any of them different, tell the
day0 maintainers so this page can say what is true.
