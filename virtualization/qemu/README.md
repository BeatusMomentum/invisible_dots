# QEMU

`windows.json` pins the official QEMU installer that `invisible-dots setup`
runs on Windows (architecture section 11.2): version, URL, SHA-256 and SHA-512,
the silent switch and the default install directory. Its `verification` list
says where each value comes from. Linux gets QEMU from the distribution.

The command line of a Dot's VM is built by `qemuArgs()` in
`apps/vm-manager/src/qemu-args.ts`, the same on both hosts apart from
`-accel` (section 3.4). Notes on it, from runs against real QEMU:

- **There is no monitor.** No `-qmp`, no `-monitor`, no `-S`. The control
  plane sees QEMU only as a process (its pid, and the guest port its user
  networking listens on) and reaches the guest only through dot-agentd
  (section 5.1). A stop is `POST /v1/system/poweroff` to the guest; QEMU exits
  when the guest is off. This removed the one Windows-only code path the
  host had: Node has no AF_UNIX client on Windows, so a QMP unix socket needed
  a PowerShell bridge there, and QEMU's `pipe` chardev blocks the start until a
  client connects and accepts one client for the life of the process.
- **QEMU 8.2 (Ubuntu 24.04's `qemu-system-x86`, 8.2.2) runs the argv of
  section 3.4 as it is** with KVM: `-cpu host` accepted, the `hostfwd` port
  listening about 0.2 s after the spawn, the process still running 2 s later,
  nothing written to its log. A port already taken makes it exit with code 1
  and `Could not set up host forwarding rule 'tcp:127.0.0.1:<port>-:1024'`,
  the message the start retries on.
- **Ports for `hostfwd`** come from binding port 0 on 127.0.0.1. On a Windows
  host with Hyper-V, fixed ports such as 45123 failed with "Could not set up
  host forwarding rule" while kernel-chosen ones worked; the start retries with
  a new port when that message appears.
- **The doctor probe** (`-nodefaults -no-user-config -machine q35 -accel <a>
  -cpu host -display none -no-reboot -boot reboot-timeout=0`) runs the
  firmware of an empty machine: with QEMU 8.2.2 and KVM it exits with code 0
  after 0.2 s, and SeaBIOS's debug port reads "No bootable device. Retrying in
  0 seconds." then "Rebooting.". Without `-no-reboot`, or without the reboot
  timeout, QEMU never exits. Not measured with WHPX yet.
- **`-cpu host` under WHPX**: on a Windows 11 host with the Virtual Machine
  Platform feature on and the Hypervisor Platform feature off, QEMU 11.1
  started with `-accel whpx -cpu host`, then reported `WHPX: Unexpected VP
  exit code 4` and left the VM paused (QEMU kept running). `-cpu qemu64` ran.
  Without a monitor that state shows as a guest that never answers: the READY
  procedure fails with the end of QEMU's log and of the serial console, and
  the doctor probe never exits. Whether `-cpu host` runs once the Hypervisor
  Platform feature is on is still to be measured; section 3.4 says no other
  model is used without a recorded decision.
- **`-machine none -accel whpx`** aborts QEMU 11.1 for Windows with an
  `X86_MACHINE` assertion, so a doctor check that starts QEMU that way cannot
  tell a working WHPX from a broken one on Windows; `-machine q35` is needed.
- With `-accel kvm` and no `/dev/kvm`, QEMU 10.0 exits with `Could not access
  KVM kernel module: No such file or directory`; the vm-manager turns that into
  an error naming `invisible-dots doctor` and `invisible-dots setup`.
