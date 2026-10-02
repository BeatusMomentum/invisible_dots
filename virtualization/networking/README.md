# Networking

Every Dot has one virtio NIC on the libvirt network `invisible-dots`
(`../libvirt/network.xml`): NAT to the host's uplink, bridge `idots0`,
subnet `10.213.0.0/24`, gateway `10.213.0.1`, DHCP from `.10` to `.254`.

- The subnet avoids libvirt's `default` network (`192.168.122.0/24`) and the
  ranges Docker hands out (`172.17.0.0/16` and up, `192.168.0.0/16` pools on
  some hosts). If it collides with something on your host, edit
  `network.xml` before the network is first defined.
- Guests reach the internet through NAT; nothing on the network reaches a
  guest from outside. The host talks to guests over vsock only (architecture
  section 5.1), never over this network, so no port forwarding is needed.
- Guests can reach each other on this bridge. Isolating them is a network
  policy, which is out of scope for this version.

`ensure-network.sh` defines, autostarts and starts the network and is safe to
run again. It honours `LIBVIRT_DEFAULT_URI` (default `qemu:///system`) and
`NETWORK_XML`.
