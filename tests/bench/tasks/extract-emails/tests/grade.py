"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

check(lines("/app/emails.txt") == ['anna@acme.io', 'anna@example.com', 'info@acme.io', 'info@example.com', 'info@mail.co.uk', 'j_smith@acme.io', 'j_smith@example.com', 'j_smith@mail.co.uk', 'marco@acme.io', 'marco@example.com', 'marco@mail.co.uk', 'support@acme.io', 'support@example.com', 'team.lead@acme.io', 'team.lead@example.com', 'team.lead@mail.co.uk'], "every distinct address, lower case, sorted")
