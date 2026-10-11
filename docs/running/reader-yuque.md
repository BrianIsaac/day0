# Reading a Yuque repository

This page is for whoever holds the Yuque account day0 reads with (an administrator of the
space, usually), and the manager who links the repository on the Documentation page. day0 reads
one Yuque repository (知识库) and keeps each document as Markdown beside the team's other
documentation. It only reads: it writes nothing to Yuque.

## What day0 reads

- Every **document** in the repository, under its title: a document written in Markdown as it
  is, and any other through Yuque's HTML of it, converted, with its tables kept.
- A document that is a **draft** (never published) is read and marked a draft, so an employee
  does not act on it. A document **deleted** from the repository is marked archived, and nothing
  of its text is kept.
- A sheet, a data table, a board or a thread is named as not read.
- The repository is read again on the same schedule as every other source. Yuque allows 5,000
  requests an hour for a token, so day0 spaces its requests about 0.7 seconds apart, and waits
  when Yuque says it is busy (HTTP 429). Each document costs one request at every read, so a
  repository of more than about 1,200 documents cannot be read inside that limit at the usual
  schedule: link the part of it that matters as its own repository.

## 1. Create the token

1. Yuque gives API tokens on a **paid plan** only: 超级会员 for a personal account, 旗舰版 for a
   team space. Without one there is no token to create.
2. Signed in as an account that may read the repository, open the account's settings, then
   **Token**, and create one that may **read** repositories and documents. Copy it: Yuque shows
   it once. In a team space, the token belongs to the space and its administrator creates it.

## 2. Link it (the manager)

On the Documentation page, under **Link a documentation location**:

1. **Kind of location**: Yuque repository.
2. **Location label**: a name your team recognises, for example `RevOps runbooks`.
3. **Where it is**: the repository's address, or the address of any document in it, as your
   browser shows it. day0 keeps only the repository, for example
   `https://www.yuque.com/acme/runbooks`, or the same on your space's own address
   (`https://acme.yuque.com/...`).
4. **Token**: the token from step 1. It is encrypted when you submit the form, sent only to
   Yuque, and never shown again.
5. **Link location**. The first read starts at once; the table shows its progress.

To replace the token later, use **Rotate** on the source's row. To change the repository,
**Unlink** the source and link it again.

## What a page day0 cannot read shows

- `"Q3 numbers" is a Yuque sheet, which Day0 does not read: only documents are read.` The same
  sentence names a data table, a board or a thread.
- `"..." was deleted or moved in Yuque after it was listed.`
- `Yuque gave no body for "...", so Day0 does not read it.`

When the whole repository cannot be read, its status says why:

- `Yuque refused the token this source uses (HTTP 401): it may have been revoked, or the paid
plan that gives API tokens may have lapsed. Ask the token's owner to create a new one in Yuque's
account settings, with read access to repositories and documents, then use Rotate on the source's
row to enter it.`
- `Yuque refused this request for the token's owner (HTTP 403): ask a repository administrator to
give that account read access to revops/runbooks, and check the token's scope lets it read
repositories and documents.`
- `Yuque found no repository at acme.yuque.com/revops/nowhere that the token's owner may read
(HTTP 404): check the address. To change it, unlink the source and link it again.`
- `Yuque was rate limited (HTTP 429).` Yuque stayed busy past day0's waits; the next read tries
  again.
- `Day0 could not reach www.yuque.com: ...` Nothing answered at that host from the machine the
  backend runs on. See the next section.

## For the network

The backend reaches the host in the repository's address over HTTPS: `www.yuque.com`, or your
space's own `<space>.yuque.com`. In real mode `pnpm check:setup` lists `www.yuque.com` in its
egress list. The backend connects directly: it uses no HTTP proxy.

## Not yet checked against a real space

The reader is built against Yuque's published API specification (Yuque's own copy of it,
version 2.0.1, read 10 October 2026), with test answers written from that specification, not
recorded from a space: **no tenant read yet**. Until one is, these are known only from the
specification: that a document's status 0 is a draft and 1 is published; that the deleted view
lists the deleted documents and a token may see it; what Yuque answers when it refuses a token;
and whether a space's own address serves the API as `www.yuque.com` does. If a first install
finds any of them different, tell the day0 maintainers so this page can say what is true.
