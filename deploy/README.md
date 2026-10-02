# Deploying invisible_dots on a host

Everything here installs the control plane on one Linux host with KVM
(architecture sections 2, 3.1 and 3.2).

| file | what |
|---|---|
| `install.sh` | checks the requirements, builds and installs the tree, creates the user, directories, secrets, network and units |
| `docker-compose.yml` | PostgreSQL 18 for the control plane, bound to `127.0.0.1` |
| `systemd/invisible-dots-server.service` | the control plane (`invisible-dots-server`: API, scheduler, vm-manager) |
| `systemd/invisible-dots-web.service` | the web client on `127.0.0.1:3000` |
| `dev/` | a container with libvirt and qemu, for development hosts |

## Install

```sh
sudo deploy/install.sh --check          # what is missing, nothing is changed
sudo deploy/install.sh --build-images   # install, then build the golden image and the runtime ISO
printf '%s' "$OPENROUTER_KEY" | sudo invisible-dots secret openrouter
```

`install.sh` copies the checkout to `/usr/local/lib/invisible-dots` (`--prefix`)
and builds it there, so the checkout itself is left untouched. It creates the
system user `invisible-dots` (in the `libvirt` and `kvm` groups), the state
directory `/var/lib/invisible-dots`, and `/etc/invisible-dots` with
`master.key`, `api.token` and `server.env`. Existing secrets are never
replaced: a new `master.key` would make every stored secret unreadable.

Without `--database-url`, PostgreSQL runs from `docker-compose.yml` with a
generated password kept in `/etc/invisible-dots/postgres.env`.

Running `install.sh` again upgrades the code in place and keeps the secrets,
the database and every Dot. A new runtime ISO (`--build-images`, or
`guest/image-builder/build-runtime.sh`) reaches each Dot on its next start.

## Permissions

- The server runs as `invisible-dots` and talks to `qemu:///system` through
  the `libvirt` group. libvirt (with its default `dynamic_ownership`) gives the
  qemu process access to each Dot's overlay, seed and serial log while the VM
  runs, so the VM directories only need to be traversable (`0755`).
- Golden images are `0444` and owned by whoever built them.
- On hosts with AppArmor, libvirt's `virt-aa-helper` adds the disk, seed,
  runtime ISO and serial log paths of each domain to its profile. If a start
  fails with "permission denied" on a path under `/var/lib/invisible-dots`,
  check `journalctl -k | grep apparmor` and the libvirt `security_driver`.

## Development container

```sh
docker build -t invisible-dots-dev deploy/dev
sudo modprobe vhost_vsock
docker run -d --name idots-dev --privileged \
  --device /dev/kvm --device /dev/vhost-vsock \
  -v "$PWD":/src \
  -v /var/lib/invisible-dots:/var/lib/invisible-dots \
  invisible-dots-dev
docker exec -it idots-dev bash
```

Inside, `virsh`, `qemu-img`, `socat`, `cloud-localds` and `xorriso` are
available and the `invisible-dots` network is defined; the server can be run
from `/src` with `node apps/api/dist/invisible-dots-server.mjs` once it is
built and `DATABASE_URL` points at a PostgreSQL.
