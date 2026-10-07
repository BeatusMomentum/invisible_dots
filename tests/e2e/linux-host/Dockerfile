# A Linux host for the end-to-end run (tests/e2e/README.md), for machines
# where the real host cannot be used directly (for example WSL without QEMU
# or sudo). TEST HARNESS ONLY: the product never runs in a container.
#
# The final image holds exactly what a person on Ubuntu 24.04 installs for
# invisible_dots (docs/architecture.md section 3.1): the distribution's QEMU
# (qemu-system-x86, qemu-utils), CA certificates, and Node 24 from the
# official tarball. Nothing else, so the run fails if the product starts to
# depend on any other host program.

# Stage 1 downloads Node and checks it. curl stays in this stage and never
# reaches the host image.
FROM ubuntu:24.04 AS node
ARG NODE_VERSION=24.21.0
# The tarball's hash, pinned here and also required to match the line in the
# release's SHASUMS256.txt, so a moved file and a moved list both fail.
ARG NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; \
    tarball="node-v${NODE_VERSION}-linux-x64.tar.gz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep "  ${tarball}\$" SHASUMS256.txt > expected.txt; \
    test "$(cut -d' ' -f1 expected.txt)" = "${NODE_SHA256}"; \
    sha256sum -c expected.txt; \
    mkdir /opt/node; \
    tar -xzf "${tarball}" -C /opt/node --strip-components=1

# Stage 2 is the host.
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates qemu-system-x86 qemu-utils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /opt/node /opt/node
ENV PATH=/opt/node/bin:$PATH
# An ordinary user, as on a real host: the run never needs root. /dev/kvm is
# reached through the group the device has on the machine running docker
# (docker run --group-add), the same as `usermod -aG kvm` on a real host.
# /data and /work are created here so the named volumes mounted on them start
# owned by this user. It has the uid and gid of the person building the image
# (--build-arg, README), so the key file mounted from their home reads as it
# does for them, mode 0600 included; the image's own ubuntu user (1000) goes
# to free that uid.
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN userdel --remove ubuntu \
 && groupadd --gid "$HOST_GID" dots \
 && useradd --create-home --shell /bin/bash --uid "$HOST_UID" --gid dots dots \
 && mkdir -p /data /work \
 && chown dots:dots /data /work
USER dots
WORKDIR /work
