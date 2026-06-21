# Obsidian node image: real Obsidian (Electron) under Xvfb, plus x11vnc for the
# one-time Sync login. We drive it from the host via `podman exec`, so there is
# no sshd. Obsidian is the portable .tar.gz build at /opt/obsidian, launched via
# the /usr/local/bin/obsidian wrapper; the CLI is /opt/obsidian/obsidian-cli.

FROM debian:bookworm-slim

ARG OBSIDIAN_VERSION=1.12.7
# TARGETARCH is provided automatically by the builder (arm64 on Apple-Silicon
# Podman machines, amd64 on typical EC2). Pick the matching build.
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        wget ca-certificates \
        xvfb x11vnc \
        dbus dbus-x11 \
        procps \
        # zlib is linked by the Obsidian/Electron binary
        zlib1g \
        # Electron / Obsidian runtime libraries
        libgtk-3-0 libnss3 libasound2 libgbm1 libxshmfence1 \
        libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
        libatk1.0-0 libatk-bridge2.0-0 libcups2 libpango-1.0-0 libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Download + extract the arch-appropriate portable build (.tar.gz).
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) SUFFIX="-arm64" ;; \
      amd64|"") SUFFIX="" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian-${OBSIDIAN_VERSION}${SUFFIX}.tar.gz"; \
    wget -q -O /tmp/obsidian.tar.gz "$url"; \
    mkdir -p /opt/obsidian; \
    tar -xzf /tmp/obsidian.tar.gz -C /opt/obsidian --strip-components=1; \
    rm /tmp/obsidian.tar.gz

# Thin launcher for the GUI binary.
RUN printf '#!/bin/sh\nexport LD_LIBRARY_PATH="/opt/obsidian:$LD_LIBRARY_PATH"\nexec /opt/obsidian/obsidian "$@"\n' > /usr/local/bin/obsidian \
    && chmod +x /usr/local/bin/obsidian

# Fixed locations the login/seed flow relies on (the image ships NO credentials;
# the captured login is bind-mounted at /secrets and seeded in by entrypoint.sh).
RUN mkdir -p /root/.config/obsidian /root/vaults/TestVault/.obsidian

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# VNC, only used during the login/capture phase.
EXPOSE 5900
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
