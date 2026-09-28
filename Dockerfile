FROM node:22-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD true

# Optional npm registry mirror. The installs below pull ~1500 packages, and on a
# slow or filtered link one read times out in the middle of `npm ci` — npm then
# dies with "Exit handler never called!", which hides the real ETIMEDOUT and
# fails the whole build. Point the build at a mirror when that happens:
#   NPM_REGISTRY=https://registry.npmmirror.com docker compose build
ARG NPM_REGISTRY

# Pin npm to the version the lockfile was written with (`packageManager` in
# package.json). The floating `node:22-slim` tag ships a different npm patch on
# every rebuild, so two machines can run two different npm versions against the
# same lockfile.
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
	&& npm install -g npm@11.6.2

# Long, network-bound installs on operator machines: give Node room, retry a
# flaky registry instead of failing the build, and skip audit/fund, which only
# add round trips and noise.
ENV NODE_OPTIONS=--max-old-space-size=4096 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=600000


FROM base AS build

WORKDIR /nodecg

RUN apt-get update && apt-get install -y python3 build-essential
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package.json package-lock.json ./
COPY workspaces workspaces
COPY tsconfig.json tsdown.config.ts ./
COPY scripts scripts

# The npm cache is wiped in the same layer: it is a few hundred MB of tarballs
# that nothing later needs, and Docker Desktop disks fill up quickly.
RUN npm ci \
	&& npm cache clean --force

RUN npm run build


# ---------------------------------------------------------------------------
# notGT bundle (bundles/notGT)
#
# The bundle is NOT an npm workspace of this monorepo: it has its own
# package.json/package-lock.json and its own node_modules, so it is installed
# and built from inside its own directory. `bundles/` is intentionally NOT
# excluded by .dockerignore so this stage can see it; the host-side
# `bundles/notGT/node_modules` is excluded by `**/node_modules`.
# ---------------------------------------------------------------------------
FROM base AS bundle-build

WORKDIR /build

RUN apt-get update && apt-get install -y python3 build-essential
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY bundles bundles

WORKDIR /build/bundles/notGT

# `package-lock.json` is committed in the bundle, so `npm ci` (not
# `npm install`) is the right command. The bundle's node_modules is a
# build-time-only dependency and is removed in the SAME layer that creates it,
# so it never ends up in an image layer. The build output (extension/index.js
# plus the Vite-bundled dashboard/graphics assets) is self-contained.
RUN npm ci \
	&& npm run build \
	&& rm -rf node_modules \
	&& npm cache clean --force


FROM base AS npm

WORKDIR /nodecg

RUN apt-get update && apt-get install -y python3 build-essential

COPY package.json package-lock.json ./
COPY --from=build /nodecg/workspaces workspaces

RUN npm ci --omit=dev \
	&& npm cache clean --force


FROM base AS runtime

WORKDIR /opt/nodecg

# ffmpeg powers the drag-and-drop conversion in the editor (ProRes/HEVC .mov ->
# WebM/WebP with alpha). Build with --build-arg INSTALL_FFMPEG=false to skip it;
# the editor then reports that server-side conversion is unavailable.
ARG INSTALL_FFMPEG=true
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& if [ "$INSTALL_FFMPEG" = "true" ]; then \
		apt-get install -y --no-install-recommends ffmpeg; \
	fi \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir cfg bundles logs db assets

COPY package.json index.js ./
COPY --from=npm /nodecg/node_modules node_modules
COPY --from=npm /nodecg/workspaces workspaces
COPY --from=build /nodecg/workspaces/nodecg/dist workspaces/nodecg/dist

# The already-built notGT bundle: extension/, configschema.json, package.json
# plus the generated dashboard/ and graphics/ assets. It is copied from the
# bundle-build stage (not from the build context) so the freshly generated
# artifacts are guaranteed to be present, and it deliberately carries no
# node_modules: the bundle's dependencies are build-time only.
COPY --from=bundle-build /build/bundles bundles

# Define directories that should be persisted in a volume
VOLUME /opt/nodecg/logs /opt/nodecg/db /opt/nodecg/assets
# Define ports that should be used to communicate
EXPOSE 9090/tcp

# Define command to run NodeCG
# Using `node` directly is slightly faster than using `nodecg start`.
CMD ["node", "/opt/nodecg/index.js"]
