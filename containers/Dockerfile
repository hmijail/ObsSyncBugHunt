# Obsidian node image: real Obsidian (Electron) under Xvfb, plus x11vnc for the
# one-time Sync login. We drive it from the host via `podman exec`, so there is
# no sshd. The harness calls the Obsidian CLI through the /usr/local/bin/obsidian
# wrapper (which runs the extracted AppImage's AppRun so library paths are set).

FROM debian:bookworm-slim

ARG OBSIDIAN_VERSION=1.12.7
# TARGETARCH is provided automatically by the builder (arm64 on Apple-Silicon
# Podman machines, amd64 on typical EC2). Pick the matching AppImage.
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        wget ca-certificates \
        xvfb x11vnc \
        dbus dbus-x11 \
        procps \
        # Electron / Obsidian runtime libraries
        libgtk-3-0 libnss3 libasound2 libgbm1 libxshmfence1 \
        libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
        libatk1.0-0 libatk-bridge2.0-0 libcups2 libpango-1.0-0 libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Download + extract the arch-appropriate AppImage (extract avoids needing FUSE).
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) SUFFIX="-arm64" ;; \
      amd64|"") SUFFIX="" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}${SUFFIX}.AppImage"; \
    wget -q -O /tmp/obsidian.AppImage "$url"; \
    chmod +x /tmp/obsidian.AppImage; \
    cd /opt && /tmp/obsidian.AppImage --appimage-extract; \
    mv /opt/squashfs-root /opt/obsidian; \
    rm /tmp/obsidian.AppImage

# Wrapper: GUI launch (no args) and CLI (subcommands) both go through AppRun.
RUN printf '#!/bin/sh\nexec /opt/obsidian/AppRun "$@"\n' > /usr/local/bin/obsidian \
    && chmod +x /usr/local/bin/obsidian

# Fixed locations the login/seed flow relies on (the image ships NO credentials;
# the captured login is bind-mounted at /secrets and seeded in by entrypoint.sh).
RUN mkdir -p /root/.config/obsidian /root/vaults/TestVault/.obsidian

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# VNC, only used during the login/capture phase.
EXPOSE 5900
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
