"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)

import hashlib, shutil
EXPECTED = {'card_testing': ['C00081', 'C00083', 'C00457', 'C00802', 'C01181', 'C01332', 'C02286', 'C02483', 'C02661', 'C02887', 'C02965', 'C03044', 'C03054', 'C03444', 'C03710'], 'impossible_travel': ['A00028', 'A00061', 'A00113', 'A00154', 'A00191', 'A00242', 'A00284', 'A00330', 'A00362', 'A00383', 'A00600', 'A00644', 'A00719', 'A00793', 'A00839', 'A00857', 'A00914', 'A01003', 'A01057', 'A01261', 'A01266', 'A01368', 'A01459', 'A01665', 'A01717', 'A01723', 'A01763', 'A01817', 'A01823', 'A01934', 'A01942'], 'duplicate_charges': ['T0002004', 'T0010791', 'T0011102', 'T0018196', 'T0022923', 'T0029392', 'T0035498', 'T0037782', 'T0039369', 'T0042081', 'T0054649', 'T0080341', 'T0088881', 'T0092223', 'T0092596', 'T0105877', 'T0112852', 'T0115380', 'T0121167', 'T0132761', 'T0139911', 'T0146895', 'T0158033', 'T0160007', 'T0169455', 'T0178117', 'T0208007', 'T0217065', 'T0218985', 'T0224957', 'T0225879', 'T0232815', 'T0233489', 'T0245542', 'T0252874', 'T0275299', 'T0284007', 'T0289353', 'T0289804', 'T0290218'], 'refund_merchants': ['M0280', 'M0281', 'M0282', 'M0283', 'M0284', 'M0285']}
check(hashlib.md5(open("/app/transactions.csv", "rb").read()).hexdigest() == 'be3a7df479471ad93444dde5aac5dce7', "the data is the task's (unchanged)")
def verify(what):
    got = json.loads(pathlib.Path("/app/findings.json").read_text())
    for kind, expected in EXPECTED.items():
        found = set(got.get(kind, []))
        hit = len(found & set(expected))
        check(hit == len(expected) and len(found) == len(expected), f"{what}: {kind} ({hit} of {len(expected)} found, {len(found) - hit} wrong)")
verify("findings.json")
shutil.move("/app/findings.json", "/app/findings.json.bak")
r = subprocess.run(["python3", "analyze.py"], cwd="/app", capture_output=True, text=True, timeout=600)
check(r.returncode == 0, f"analyze.py runs ({r.stderr[-300:]})")
verify("analyze.py's findings.json")
report = pathlib.Path("/app/report.md").read_text(encoding="utf-8")
counts = [str(len(v)) for v in EXPECTED.values()]
check(sum(c in re.findall(r"\d+", report) for c in counts) >= 3, "the report gives the numbers of cases")
