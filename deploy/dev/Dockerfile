# libvirt, qemu and the host tools of architecture section 3.1 in one
# container, for development hosts that should not have them installed. KVM is
# still the host's: the container gets /dev/kvm and /dev/vhost-vsock passed in.
# See deploy/dev/README.md for how to run it.
FROM node:24-bookworm

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libvirt-daemon-system libvirt-clients qemu-system-x86 qemu-utils \
      socat cloud-image-utils xorriso dnsmasq-base iptables \
      ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/idots-dev-entrypoint
RUN chmod 0755 /usr/local/bin/idots-dev-entrypoint

ENV LIBVIRT_DEFAULT_URI=qemu:///system
WORKDIR /src
ENTRYPOINT ["/usr/local/bin/idots-dev-entrypoint"]
CMD ["sleep", "infinity"]
