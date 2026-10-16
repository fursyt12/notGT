# ---------------------------------------------------------------------------
# notGT NDI sender — the outs of a notGT server as NDI sources.
#
# Built and started by docker-compose.yml (the `ndi` profile); see
# ndi/README.md#docker. Runs on x86-64, arm64 (a Raspberry Pi 4/5 with a
# 64-bit system) and 32-bit ARM.
#
# The NDI library is not part of this repository: it is NDI's, under NDI's
# licence. This build downloads the NDI SDK for Linux from NDI and keeps only
# the library — and does so only when the build is told that the licence is
# accepted: NDI_ACCEPT_LICENSE=yes (in `.env`). The licence is in the SDK, and
# the image keeps a copy at /usr/local/share/ndi/NDI-SDK-License.txt.
# ---------------------------------------------------------------------------
FROM node:22-slim

ARG NPM_REGISTRY
ARG NDI_ACCEPT_LICENSE
ARG NDI_SDK_URL=https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz
# Set by BuildKit; the classic builder leaves it empty and dpkg answers instead.
ARG TARGETARCH

# What Chromium (in Electron) needs to draw off screen, with no display.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates curl \
		libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 \
		libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxss1 \
		libpango-1.0-0 libcairo2 fonts-dejavu-core \
		libavahi-client3 libavahi-common3 \
	&& rm -rf /var/lib/apt/lists/*

# The NDI library, for this machine's architecture.
RUN if [ "$NDI_ACCEPT_LICENSE" != "yes" ]; then \
		echo "" >&2; \
		echo "The NDI sender needs the NDI library, which comes from NDI under its own licence" >&2; \
		echo "(the NDI SDK License Agreement, https://ndi.video/for-developers/ndi-sdk/)." >&2; \
		echo "To accept it and let the build download the library, put this in .env:" >&2; \
		echo "    NDI_ACCEPT_LICENSE=yes" >&2; \
		echo "" >&2; \
		exit 1; \
	fi \
	&& arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
	&& case "$arch" in \
		amd64) lib=x86_64-linux-gnu ;; \
		arm64) lib=aarch64-rpi4-linux-gnueabi ;; \
		arm|armhf) lib=arm-rpi4-linux-gnueabihf ;; \
		*) echo "NDI has no library for $arch" >&2; exit 1 ;; \
	esac \
	&& mkdir /tmp/ndi && cd /tmp/ndi \
	&& curl -fsSL --retry 3 "$NDI_SDK_URL" | tar xz \
	&& echo y | PAGER=cat sh ./Install_NDI_SDK_v6_Linux.sh > /dev/null \
	&& cp -P "NDI SDK for Linux/lib/$lib/"libndi.so* /usr/local/lib/ \
	&& mkdir -p /usr/local/share/ndi \
	&& cp "NDI SDK for Linux/NDI SDK License Agreement.txt" /usr/local/share/ndi/NDI-SDK-License.txt \
	&& ldconfig \
	&& cd / && rm -rf /tmp/ndi

WORKDIR /opt/notgt-ndi

COPY package.json package-lock.json ./
# Electron fetches its own binary for this architecture; done here, so the
# container never downloads anything when it starts.
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
	&& npm ci --omit=dev --no-audit --no-fund \
	&& node node_modules/electron/install.js \
	&& npm cache clean --force

COPY . .

# Docker Compose overrides these; they are what a bare `docker run` gets.
ENV NOTGT_SERVER=http://127.0.0.1:9090 \
	NODE_ENV=production

CMD ["node", "bin/notgt-ndi.mjs"]
