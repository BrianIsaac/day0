# Upgrading Day0, and the way back

How a customer install moves to a new release, and how it goes back to the
one before. Both are one command each. The upgrade prints the way back with
the backup's path filled in when it ends, and writes it into the install
record.

The steps and the times below are from test beds on 13 October 2026: an
install at `v0.20.0` upgraded, backed up, restored, and taken back to
`v0.20.0` by the upgrade's backup.

## Before you upgrade

- **Read the release's Upgrading note** in `CHANGELOG.md`: it names every
  new setting and anything the release changes about how Day0 runs.
- **One release at a time.** The upgrade refuses a jump of more than one
  release and names the release to go through first.
- **Know where the backups go**: `~/day0-backups/<project>/`, or the
  directory `--to <dir>` names. A backup holds the deployment's keys and
  every row, so the directory belongs where you keep secrets, and outside
  the checkout.
- **Nothing is pulled.** The new release is the checkout you run the
  command from:

```bash
git fetch --tags
git checkout v0.21.0
./setup.sh upgrade
```

## What the upgrade does

In this order, stopping at the first step that fails and saying what was
and was not changed:

1. **The target checks**: the installation is this checkout's, and its
   project is the one `.env.local` names.
2. **The scheduled jobs are paused**, so nothing polls your systems or
   posts while the rows move ("Paused the scheduled jobs ...; each skips
   until the check passes").
3. **A backup** of the data volume, with its checksum and a description
   beside it. An upgrade that cannot take one stops there: "nothing is
   installed or pushed without a backup".
4. **The dependencies** the new checkout names (`pnpm install
   --frozen-lockfile`).
5. **The backend's image, built on this machine** (below).
6. **The services**, started on the new checkout.
7. **The release check**: the release the rows are at, read from the
   deployment before anything is pushed.
8. **The functions**, pushed (`npx convex dev --once`). A push the new
   schema refuses leaves the old functions serving.
9. **The migrations** the release ships, then the release's stamp.
10. **The settings**, pushed to the deployment (`pnpm sync:env`), and the
    backend restarted.
11. **`pnpm check:setup`**, and once it passes the scheduled jobs are
    released.
12. **The way back**, printed, and the install record's section written.

Then build and start the app again, since the app is this checkout's too:
`pnpm build`, and `pnpm start` under your service manager.

## The image is built at your site

Day0 publishes no backend image. Each install and each upgrade builds
`day0-convex-backend:git` on this machine, from the Convex backend the
release pins by digest (`docker/backend.Dockerfile`) with `git` added and
nothing else. So an upgrade needs what a first install needed: the pinned
base image from `ghcr.io` and git's packages from the Ubuntu archive, or a
mirror of it ([the install runbook](install.md), "How long it takes").
Where a build fails, the upgrade goes on with an image already on the
machine if it was built from the same pinned backend, and says so.

The install record names the image by its id and by the digest of the
pinned backend it was built from, so IT can say afterwards exactly what
ran.

## The way back

The upgrade ends on three lines:

```
The way back: ./setup.sh restore ~/day0-backups/day0/day0-20261013T102422Z.tar.gz from a checkout of v0.20.0 (commit 26d76e0d31d2). Never start the old image over this volume.
  The steps, and why the old image is never the way: docs/running/upgrade-and-rollback.md
The install record: ~/day0-install/day0/install-record-2026-10-13.md
```

The first is the whole instruction, and the install record's section for
the upgrade carries it again. To follow it:

1. **Check out the release you are going back to**, the one the line
   names, and install its dependencies:

   ```bash
   git checkout v0.20.0
   pnpm install --frozen-lockfile
   ```

2. **Restore the upgrade's backup** from that checkout:

   ```bash
   ./setup.sh restore ~/day0-backups/day0/day0-20261013T102422Z.tar.gz
   ```

   It checks the file against its checksum, asks, takes a backup of the
   volume it is about to replace (so the upgraded rows are kept too), puts
   the backup's volume back, starts the services on the old checkout and
   pushes the old release's functions. The backup was taken as the upgrade
   began, so it carries that upgrade's pause on the scheduled jobs; the
   restore lifts it and says so once its closing `pnpm check:setup`
   passes. Where that check stops on a gap, the pause stays until
   `./setup.sh unpause`.

3. **Build and start the app** from the old checkout: `pnpm build`, then
   `pnpm start`.

A restore rewinds everything to the moment of the backup. Work that landed
on your systems after it is unknown to the restored rows, so go back soon
after an upgrade or not at all.

The backup's own description (the `.json` beside it) names the checkout
that **took** it, which during an upgrade is the new one. The release and
commit to check out for the way back are the ones the printed line and the
install record give: the release the rows were at.

### Never start the old image over the upgraded volume

Going back by starting the previous backend image on the volume the upgrade
left is not a way back, and nothing refuses it. Driven on a bed at an
earlier release: the old backend starts, reports healthy, logs "persisted
db metadata version is ahead" as a warning, and serves the newer rows and
functions with its search-index workers dead. You would be running the new
release's data on the old release's backend, with a release stamp the next
upgrade reads as the new release.

Pushing the old release's functions over the upgraded rows is refused, and
loudly: from a `v0.20.0` checkout against an upgraded deployment, "Schema
validation failed. Document ... does not match the schema: Object contains
extra field ... that is not in the validator", exit 1, nothing changed. The
first documentation sync after the upgrade to v0.21.0 writes such a field
on every stored page.

So the way back is always the backup.

### What a restore refuses

- **A file that does not match its checksum.**
- **An install pointed at the test Slack** (`DAY0_TEST_SLACK_API_URL` set
  in `.env.local`, as on a demonstration bed): "A restore brings a real
  deployment back and never runs on the test profile: empty them first".
  Empty the two `DAY0_TEST_SLACK_*` settings and run it again.

## How long it takes

On the beds, real mode, a machine that already held the images:

| Step | Time |
|---|---|
| `./setup.sh upgrade` from `v0.20.0` (the backup, the push and the checks included) | 78 s, and 50 s a second time |
| `./setup.sh backup` | 4 s |
| `./setup.sh restore` of that backup | 51 s |
| The way back: `./setup.sh restore <the upgrade's backup>` from a `v0.20.0` checkout | 82 s (57 s on a second bed) |

The beds held a handful of rows. The backend is stopped while a backup is
copied, so people's pages pause for that long.

## The install record

`~/day0-install/<project>/install-record-<date>.md` (`--record <dir>`
elsewhere) gains a dated section from each of `install`, `upgrade`,
`backup` and `restore`, the latest last:

- **an install**: the release and commit, Day0's public address and the
  backend's, the image's id and the pinned backend it was built from, where
  the backups go, the company sign-in as registered, each step's outcome
  and the reverse proxy's two rows;
- **an upgrade**: from which release to which, the backup it took (its
  path, its checksum, the release and commit its rows were at) and the way
  back;
- **a backup**: the file, its checksum and what its rows were at;
- **a restore**: what was put back, and the backup taken of what it
  replaced.

It holds no secret. A backup it names does: keep the record with IT and
the backups where you keep secrets. A release before v0.21.0 does not
write these sections, so the way back to `v0.20.0`, which is driven from
its checkout, adds none: note it in the record by hand.
