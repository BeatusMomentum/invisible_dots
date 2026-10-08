"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

out = subprocess.run(["ssh", "-G", "buildbox"], capture_output=True, text=True).stdout.lower().splitlines()
conf = dict(l.split(" ", 1) for l in out if " " in l)
check(conf.get("hostname") == "10.20.30.40", "HostName")
check(conf.get("port") == "2222", "Port")
check(conf.get("user") == "deploy", "User")
key = os.path.expanduser("~/.ssh/buildbox_ed25519")
check(any(os.path.expanduser(v) == key for k, v in (l.split(" ", 1) for l in out if l.startswith("identityfile "))), "IdentityFile")
check(os.path.exists(key) and "OPENSSH PRIVATE KEY" in open(key).read(), "the private key exists")
pub = pathlib.Path("/app/buildbox.pub").read_text().split()
check(pub[0] == "ssh-ed25519" and pub[1] == open(key + ".pub").read().split()[1], "buildbox.pub is the key's public half")
check(subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", key], capture_output=True).returncode == 0, "no passphrase")
