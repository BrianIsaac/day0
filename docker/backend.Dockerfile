# The backend day0 runs: the pinned self-hosted Convex backend with git added, so a git
# documentation source on a host DAY0_PRIVATE_HOSTS or DAY0_GIT_HOSTS lists is cloned on a stock
# install (wave 14, 14-F's ruling 1 (a)); the upstream image carries no git. Nothing else is
# added. Built by ./setup.sh at every install and upgrade (`pnpm backend:build`) as
# day0-convex-backend:git; docker-compose.yml's backend runs it.
#
# The FROM line is the backend's pin (RM8), and the only one: re-pin it as docker-compose.yml's
# header says, then build again.
FROM ghcr.io/get-convex/convex-backend:latest@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
