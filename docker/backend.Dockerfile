# The backend day0 runs: the pinned self-hosted Convex backend with git added, so a git
# documentation source on a host DAY0_PRIVATE_HOSTS or DAY0_GIT_HOSTS lists is cloned on a stock
# install (wave 14, 14-F's ruling 1 (a)); the upstream image carries no git. Nothing else is
# added. Built by ./setup.sh at every real-mode install and upgrade, and in mock mode when no image
# of this base is here (`pnpm backend:build`), as
# day0-convex-backend:git; docker-compose.yml's backend runs it.
#
# The FROM line is the backend's pin (RM8), and the only one: re-pin it as docker-compose.yml's
# header says, then build again.
FROM ghcr.io/get-convex/convex-backend:latest@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
# The Ubuntu mirror apt reads git from, for a machine that cannot reach the archive
# (docs/running/install.md): its whole address, as in
#   pnpm backend:build --build-arg APT_MIRROR=https://mirror.example/ubuntu
# (https://mirror.example/ubuntu-ports on arm64). Unset, the sources are the base image's own.
ARG APT_MIRROR=""
# The digest of the FROM line above, repeated so the built image says which base it was built
# from: the setup, the demo bed's pre-flight and `pnpm check:setup --report` read it, and trust
# the machine-wide tag day0-convex-backend:git by it. tests/docker-compose.test.ts holds the two
# equal, so a re-pin changes both lines.
LABEL dev.dayzer0.backend.base="sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4"
RUN if [ -n "$APT_MIRROR" ]; then \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i -E \
      "s#https?://(archive|security|ports)\.ubuntu\.com/ubuntu(-ports)?/?#${APT_MIRROR%/}/#g" {} +; \
  fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
