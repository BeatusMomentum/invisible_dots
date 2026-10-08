"""Writes the in-house benchmark tasks under tests/bench/tasks (Harbor's task format), data included.

Every task's data is generated here with a fixed seed, and the expected answers are computed here from
that data and written into the task's grader, so the graders never trust the agent's own computations.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import random
import statistics
import sys
import textwrap
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(sys.argv[1])

TOML = """schema_version = "1.4"

[metadata]
category = "{category}"
difficulty = "{difficulty}"

[verifier]
timeout_sec = 300.0

[agent]
timeout_sec = {agent_timeout}

[environment]
build_timeout_sec = 900.0
cpus = {cpus}
memory_mb = {memory_mb}
"""

TEST_SH = """#!/bin/bash
# The reward is 1 when grade.py passes every check, 0 otherwise; its output says which check failed.
mkdir -p /logs/verifier
if python3 /tests/grade.py; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
"""

GRADE_HEAD = '''"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)
'''


def task(name, *, category, difficulty, instruction, files=None, setup=(), solve, grade, agent_timeout=900, cpus=1, memory_mb=2048, workdir="/app"):
    base = ROOT / name
    (base / "environment").mkdir(parents=True, exist_ok=True)
    (base / "solution").mkdir(exist_ok=True)
    (base / "tests").mkdir(exist_ok=True)
    (base / "task.toml").write_text(TOML.format(category=category, difficulty=difficulty, agent_timeout=float(agent_timeout), cpus=cpus, memory_mb=memory_mb), encoding="utf-8", newline="\n")
    (base / "instruction.md").write_text(textwrap.dedent(instruction).strip() + "\n", encoding="utf-8", newline="\n")
    docker = ["FROM ubuntu:24.04", f"WORKDIR {workdir}"]
    for rel, content in (files or {}).items():
        target = base / "environment" / "files" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8", newline="\n")
    if files:
        docker.append(f"COPY files/ {workdir}/")
    docker += [f"RUN {step}" for step in setup]
    (base / "environment" / "Dockerfile").write_text("\n".join(docker) + "\n", encoding="utf-8", newline="\n")
    (base / "solution" / "solve.sh").write_text("#!/bin/bash\nset -euo pipefail\ncd /app\n" + textwrap.dedent(solve).strip() + "\n", encoding="utf-8", newline="\n")
    (base / "tests" / "test.sh").write_text(TEST_SH, encoding="utf-8", newline="\n")
    (base / "tests" / "grade.py").write_text(GRADE_HEAD + "\n" + textwrap.dedent(grade).strip() + "\n", encoding="utf-8", newline="\n")


rng = random.Random(20261008)

# --- shell -------------------------------------------------------------------

ips = [f"10.0.{rng.randint(0, 9)}.{rng.randint(1, 254)}" for _ in range(25)]
weights = [rng.randint(1, 40) for _ in ips]
log = []
for i in range(600):
    ip = rng.choices(ips, weights)[0]
    log.append(f'{ip} - - [{10 + i // 200:02d}/Oct/2026:{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d} +0000] "GET {rng.choice(["/", "/api/items", "/login", "/static/app.js"])} HTTP/1.1" {rng.choice([200, 200, 304, 404, 500])} {rng.randint(120, 9000)}')
top = Counter(line.split()[0] for line in log).most_common()
while top[2][1] == top[3][1]:
    log.append(f'{top[2][0]} - - [12/Oct/2026:23:59:59 +0000] "GET / HTTP/1.1" 200 512')
    top = Counter(line.split()[0] for line in log).most_common()
errors = Counter(line.split()[0] for line in log if line.split()[8] == "500").most_common(1)[0]
task(
    "top-ips", category="shell", difficulty="easy",
    instruction="""
        `/app/access.log` is a web server log in the common log format.

        Write the three client IP addresses that made the most requests to `/app/top_ips.txt`, one per line as `<ip> <count>`, the one with the most requests first.
    """,
    files={"access.log": "\n".join(log) + "\n"},
    solve="awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -3 | awk '{print $2\" \"$1}' > top_ips.txt",
    grade=f"""
        check(os.path.exists("/app/top_ips.txt"), "top_ips.txt exists")
        got = [" ".join(l.split()) for l in lines("/app/top_ips.txt")]
        check(got == {[f"{ip} {n}" for ip, n in top[:3]]!r}, "the three IPs and counts, in order")
    """,
)

sizes = {}
tree = {}
for i in range(40):
    folder = rng.choice(["photos", "photos/2025", "docs", "docs/old", "music", "tmp"])
    name = f"{folder}/file_{i:02d}.{rng.choice(['jpg', 'pdf', 'mp3', 'bin'])}"
    size = rng.choice([rng.randint(1_000, 400_000), rng.randint(1_100_000, 5_000_000)])
    sizes[name] = size
large = sorted(((s, n) for n, s in sizes.items() if s > 1_048_576), reverse=True)
sizes_setup = " && ".join(f"mkdir -p data/{PurePosixPath(n).parent} && head -c {s} /dev/zero > data/{n}" for n, s in sizes.items())
task(
    "large-files", category="shell", difficulty="easy",
    instruction="""
        Find every file under `/app/data` that is larger than 1 MiB (1048576 bytes).

        Write them to `/app/large.txt`, one per line as `<size in bytes> <path relative to /app/data>`, largest first.
    """,
    setup=[sizes_setup],
    solve="cd data && find . -type f -size +1048576c -printf '%s %P\\n' | sort -rn > /app/large.txt",
    grade=f"""
        check(os.path.exists("/app/large.txt"), "large.txt exists")
        got = [" ".join(l.split()) for l in lines("/app/large.txt")]
        check(got == {[f"{s} {n}" for s, n in large]!r}, "every large file, with its size, largest first")
        check(len(list(pathlib.Path("/app/data").rglob("*.*"))) == {len(sizes)}, "no file was deleted")
    """,
)

task(
    "fix-script", category="shell", difficulty="medium",
    instruction="""
        `/app/backup.sh` should copy every `.txt` file of `/app/notes` (subfolders included) into `/app/backup`, keeping the folder structure, and print `backed up N files`. Running `./backup.sh` from `/app` does not work.

        Fix the script so that `cd /app && ./backup.sh` works. Do not copy the files yourself: the script must do it.
    """,
    files={
        "backup.sh": "#/bin/bash\n# Copies the notes into backup.\ncount=0\nfor f in $(find notes -name *.txt); do\n  mkdir -p backup/$(dirname $f)\n  cp $f backup/$f\n  count=$count+1\ndone\necho \"backed up $count files\"\n",
        "notes/a.txt": "alpha\n",
        "notes/b.txt": "beta\n",
        "notes/work/meeting notes.txt": "the room is B\n",
        "notes/work/todo.txt": "ship it\n",
        "notes/work/draft.md": "not a txt\n",
    },
    solve=r"""
        cat > backup.sh <<'EOF'
        #!/bin/bash
        cd "$(dirname "$0")"
        count=0
        while IFS= read -r -d '' f; do
          rel=${f#notes/}
          mkdir -p "backup/$(dirname "$rel")"
          cp "$f" "backup/$rel"
          count=$((count + 1))
        done < <(find notes -name '*.txt' -print0)
        echo "backed up $count files"
        EOF
        chmod +x backup.sh
    """,
    grade=r"""
        import shutil
        shutil.rmtree("/app/backup", ignore_errors=True)
        out = subprocess.run(["./backup.sh"], cwd="/app", capture_output=True, text=True, timeout=60)
        check(out.returncode == 0, f"./backup.sh exits 0 (got {out.returncode}: {out.stderr[-300:]})")
        check(out.stdout.strip() == "backed up 4 files", f"it says it backed up 4 files (said {out.stdout.strip()!r})")
        names = sorted(str(p.relative_to("/app/backup")) for p in pathlib.Path("/app/backup").rglob("*") if p.is_file())
        expected = [["a.txt", "b.txt", "work/meeting notes.txt", "work/todo.txt"], ["notes/a.txt", "notes/b.txt", "notes/work/meeting notes.txt", "notes/work/todo.txt"]]
        check(names in expected, f"the four .txt files, structure kept (got {names})")
        check(not any(n.endswith(".md") for n in names), "the .md file is not copied")
    """,
)

task(
    "user-service", category="shell", difficulty="medium",
    instruction="""
        Write a small HTTP server `/app/server.py` (Python standard library only) that answers `GET /health` with status 200 and the JSON body `{"status": "ok"}`, and any other path with 404.

        Then start it so that it keeps running in the background after you finish, listening on 127.0.0.1 port 8765, and write its process id to `/app/server.pid`.
    """,
    solve=r"""
        cat > server.py <<'EOF'
        import json
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    body = json.dumps({"status": "ok"}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

        HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
        EOF
        nohup setsid python3 server.py > server.log 2>&1 < /dev/null &
        echo $! > server.pid
        sleep 1
    """,
    grade=r"""
        import urllib.request, urllib.error
        pid = int(pathlib.Path("/app/server.pid").read_text().strip())
        check(os.path.exists(f"/proc/{pid}"), f"the process {pid} of server.pid runs")
        body = urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=10).read()
        check(json.loads(body) == {"status": "ok"}, "/health answers {'status': 'ok'}")
        try:
            urllib.request.urlopen("http://127.0.0.1:8765/nope", timeout=10)
            check(False, "/nope answers 404")
        except urllib.error.HTTPError as e:
            check(e.code == 404, "/nope answers 404")
    """,
)

# --- files and documents ----------------------------------------------------

people = []
first = ["Ada", "Bruno", "Chiara", "Dmitri", "Elena", "Farah", "Giulio", "Hana", "Ivo", "Jun", "Kofi", "Lea"]
for i, name in enumerate(first):
    people.append({"id": i + 1, "name": name, "age": rng.randint(19, 77), "city": rng.choice(["Milano", "Roma", "Torino", "Napoli"]), "member": rng.choice([True, False])})
buf = io.StringIO()
writer = csv.writer(buf, lineterminator="\n")
writer.writerow(["id", "name", "age", "city", "member"])
for p in people:
    writer.writerow([p["id"], p["name"], p["age"], p["city"], "yes" if p["member"] else "no"])
task(
    "csv-to-json", category="files", difficulty="easy",
    instruction="""
        Convert `/app/people.csv` into `/app/people.json`: a JSON array with one object per row, in the same order, with the keys `id`, `name`, `age`, `city` and `member`.

        `id` and `age` must be numbers, and `member` a boolean (`yes` is true, `no` is false).
    """,
    files={"people.csv": buf.getvalue()},
    solve="""python3 - <<'EOF'
import csv, json
rows = [dict(r, id=int(r["id"]), age=int(r["age"]), member=r["member"] == "yes") for r in csv.DictReader(open("people.csv"))]
json.dump(rows, open("people.json", "w"), indent=2)
EOF""",
    grade=f"""
        data = json.loads(pathlib.Path("/app/people.json").read_text())
        check(data == {people!r}, "every row, typed, in order")
    """,
)

downloads = {}
kinds = {"pdf": "documents", "docx": "documents", "txt": "documents", "jpg": "images", "png": "images", "mp3": "audio", "zip": "archives"}
for i in range(24):
    ext = rng.choice(list(kinds))
    downloads[f"Downloads/{rng.choice(['invoice', 'photo', 'song', 'notes', 'backup'])}_{i:02d}.{ext}"] = f"content {i}\n"
downloads["Downloads/README"] = "no extension\n"
expected_layout = sorted(f"{kinds[Path(n).suffix[1:]]}/{Path(n).name}" for n in downloads if Path(n).suffix) + ["other/README"]
task(
    "organize-downloads", category="files", difficulty="easy",
    instruction="""
        Tidy `/app/Downloads`: move every file into a subfolder of `/app/Downloads` by type: `documents` (pdf, docx, txt), `images` (jpg, png), `audio` (mp3), `archives` (zip), and `other` for anything else.

        Keep the file names, and leave no file directly in `/app/Downloads`.
    """,
    files=downloads,
    solve=r"""
        cd Downloads
        for f in *; do
          [ -f "$f" ] || continue
          case "${f##*.}" in
            pdf|docx|txt) d=documents ;; jpg|png) d=images ;; mp3) d=audio ;; zip) d=archives ;; *) d=other ;;
          esac
          [ "$f" = "${f##*.}" ] && d=other
          mkdir -p "$d" && mv "$f" "$d/"
        done
    """,
    grade=f"""
        root = pathlib.Path("/app/Downloads")
        got = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
        check(got == {sorted(expected_layout)!r}, "every file in the folder of its type, names kept")
    """,
)

emails = set()
docs = {}
for i in range(8):
    body = []
    for _ in range(rng.randint(3, 8)):
        user = rng.choice(["anna", "marco", "support", "team.lead", "j_smith", "info"])
        domain = rng.choice(["example.com", "Example.COM", "acme.io", "mail.co.uk"])
        address = f"{user}@{domain}"
        emails.add(address.lower())
        body.append(rng.choice([f"Write to {address} for details.", f"cc: <{address}>", f"({address}), thanks", f"Contact: {address}."]))
    docs[f"inbox/msg_{i}.{'md' if i % 2 else 'txt'}"] = "\n".join(body) + "\nnot-an-email@ and @nobody here\n"
task(
    "extract-emails", category="files", difficulty="medium",
    instruction="""
        The files in `/app/inbox` mention email addresses. Write every distinct address to `/app/emails.txt`, one per line, in lower case, sorted alphabetically.

        Addresses differing only in letter case are the same address.
    """,
    files=docs,
    solve="grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' inbox | tr 'A-Z' 'a-z' | sed 's/\\.$//' | sort -u > emails.txt",
    grade=f"""
        check(lines("/app/emails.txt") == {sorted(emails)!r}, "every distinct address, lower case, sorted")
    """,
)

invoices = {}
totals = defaultdict(float)
for i in range(9):
    client = rng.choice(["Rossi Srl", "Bianchi SpA", "Verdi & Co"])
    items = [{"description": rng.choice(["design", "hosting", "support", "license"]), "quantity": rng.randint(1, 5), "unit_price": round(rng.uniform(20, 400), 2)} for _ in range(rng.randint(1, 4))]
    invoices[f"invoices/inv_{i:03d}.json"] = json.dumps({"number": f"2026-{i:03d}", "client": client, "items": items}, indent=2)
    totals[client] += sum(it["quantity"] * it["unit_price"] for it in items)
report_rows = sorted(((c, round(t, 2)) for c, t in totals.items()), key=lambda r: -r[1])
task(
    "invoice-report", category="files", difficulty="medium",
    instruction="""
        `/app/invoices` holds invoices as JSON. Write `/app/report.md`: a Markdown table with the columns `Client` and `Total`, one row per client with the sum of `quantity * unit_price` over all of that client's invoices, rounded to 2 decimals, the largest total first, then a last row `TOTAL` with the sum of all.
    """,
    files=invoices,
    solve="""python3 - <<'EOF'
import json, glob, collections
t = collections.defaultdict(float)
for f in glob.glob("invoices/*.json"):
    inv = json.load(open(f))
    t[inv["client"]] += sum(i["quantity"] * i["unit_price"] for i in inv["items"])
rows = sorted(t.items(), key=lambda r: -r[1])
with open("report.md", "w") as out:
    out.write("| Client | Total |\\n|---|---|\\n")
    for c, v in rows:
        out.write(f"| {c} | {v:.2f} |\\n")
    out.write(f"| TOTAL | {sum(t.values()):.2f} |\\n")
EOF""",
    grade=f"""
        rows = []
        for l in lines("/app/report.md"):
            cells = [c.strip().strip("*") for c in l.strip().strip("|").split("|")]
            if len(cells) == 2 and not set(cells[0]) <= set("-: "):
                rows.append(cells)
        check(rows[0][0].lower() == "client" and rows[0][1].lower() == "total", "the header is Client | Total")
        body = [(c, round(float(v.replace(",", "")), 2)) for c, v in rows[1:]]
        expected = {report_rows!r} + [("TOTAL", {round(sum(totals.values()), 2)!r})]
        check(len(body) == len(expected), f"{{len(expected)}} rows")
        for (c, v), (ec, ev) in zip(body, expected):
            check(c == ec and abs(v - ev) < 0.011, f"{{ec}} totals {{ev}} (got {{c}} {{v}})")
    """,
)

# --- coding -------------------------------------------------------------------

task(
    "fix-pagination", category="coding", difficulty="medium",
    instruction="""
        `/app/paginate.py` has a function `paginate(items, page, per_page)` that should return the items of page `page` (pages start at 1) and the total number of pages. Users report that the last page is sometimes missing and that page 1 skips the first item.

        Fix the function. Keep its name and signature: other code imports it. A page past the end gives an empty list; an empty list of items has 0 pages; `page` < 1 or `per_page` < 1 raises `ValueError`.
    """,
    files={"paginate.py": "def paginate(items, page, per_page):\n    \"\"\"Return (the items of page `page`, starting at 1, the number of pages).\"\"\"\n    pages = len(items) // per_page\n    start = page * per_page\n    return items[start + 1:start + per_page], pages\n"},
    solve="""cat > paginate.py <<'EOF'
def paginate(items, page, per_page):
    \"\"\"Return (the items of page `page`, starting at 1, the number of pages).\"\"\"
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page start at 1")
    pages = -(-len(items) // per_page)
    start = (page - 1) * per_page
    return items[start:start + per_page], pages
EOF""",
    grade="""
        sys.path.insert(0, "/app")
        from paginate import paginate
        items = list(range(1, 24))
        check(paginate(items, 1, 5) == ([1, 2, 3, 4, 5], 5), "page 1 of 23 items by 5")
        check(paginate(items, 5, 5) == ([21, 22, 23], 5), "the last, short page")
        check(paginate(items, 6, 5) == ([], 5), "a page past the end is empty")
        check(paginate(list(range(10)), 2, 5) == ([5, 6, 7, 8, 9], 2), "an exact last page")
        check(paginate([], 1, 3) == ([], 0), "no items, no pages")
        for bad in ((0, 5), (1, 0)):
            try:
                paginate(items, *bad)
                check(False, f"{bad} raises ValueError")
            except ValueError:
                check(True, f"{bad} raises ValueError")
    """,
)

corpus = " ".join(rng.choice(["the", "dot", "agent", "runs", "a", "computer", "task", "files", "The", "Dot,", "agent.", "fast"]) for _ in range(700))
task(
    "wordfreq-cli", category="coding", difficulty="medium",
    instruction="""
        Write a command-line program `/app/wordfreq` (any language available on this computer; make it executable) such that `wordfreq FILE -n N` prints the N most frequent words of FILE, one per line as `<word> <count>`, most frequent first, ties in alphabetical order.

        Words are compared in lower case and are made of letters only (`Dot,` and `dot` are the same word). `-n` defaults to 10.
    """,
    files={"sample.txt": corpus},
    solve="""cat > wordfreq <<'EOF'
#!/usr/bin/env python3
import argparse, collections, re
p = argparse.ArgumentParser()
p.add_argument("file")
p.add_argument("-n", type=int, default=10)
a = p.parse_args()
words = re.findall(r"[a-z]+", open(a.file, encoding="utf-8").read().lower())
for w, c in sorted(collections.Counter(words).items(), key=lambda x: (-x[1], x[0]))[:a.n]:
    print(w, c)
EOF
chmod +x wordfreq""",
    grade="""
        import collections, tempfile
        def expected(text, n):
            words = re.findall(r"[a-z]+", text.lower())
            return [f"{w} {c}" for w, c in sorted(collections.Counter(words).items(), key=lambda x: (-x[1], x[0]))[:n]]
        texts = ["Apple banana apple, Cherry! banana apple? cherry date.", "z y x z y z w w w w", pathlib.Path("/app/sample.txt").read_text()]
        for i, text in enumerate(texts):
            f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt"); f.write(text); f.close()
            for n in (3, None):
                args = ["/app/wordfreq", f.name] + (["-n", str(n)] if n else [])
                out = subprocess.run(args, capture_output=True, text=True, timeout=30)
                got = [" ".join(l.split()) for l in out.stdout.splitlines() if l.strip()]
                check(got == expected(text, n or 10), f"text {i}, -n {n}: {got[:4]}")
    """,
)

task(
    "bash-to-python", category="coding", difficulty="medium",
    instruction="""
        `/app/summary.sh` prints a summary of a CSV file. Rewrite it in Python as `/app/summary.py` with exactly the same output for any CSV file of the same columns: `python3 /app/summary.py FILE` must print what `bash /app/summary.sh FILE` prints. Keep `summary.sh`.
    """,
    files={
        "summary.sh": "#!/bin/bash\n# Prints, for a CSV of date,category,amount (with a header), the number of rows, the total amount, and the total per category sorted by name.\nfile=$1\nrows=$(tail -n +2 \"$file\" | grep -c .)\necho \"rows: $rows\"\ntail -n +2 \"$file\" | awk -F, '{t += $3} END {printf \"total: %.2f\\n\", t}'\ntail -n +2 \"$file\" | awk -F, '{s[$2] += $3} END {for (c in s) printf \"%s: %.2f\\n\", c, s[c]}' | sort\n",
        "expenses.csv": "date,category,amount\n" + "".join(f"2026-10-{d:02d},{rng.choice(['food', 'rent', 'travel', 'books'])},{rng.uniform(1, 300):.2f}\n" for d in range(1, 29)),
    },
    solve="""cat > summary.py <<'EOF'
import csv, sys, collections
rows = list(csv.reader(open(sys.argv[1])))[1:]
rows = [r for r in rows if r]
print(f"rows: {len(rows)}")
print(f"total: {sum(float(r[2]) for r in rows):.2f}")
s = collections.defaultdict(float)
for r in rows:
    s[r[1]] += float(r[2])
for c in sorted(s):
    print(f"{c}: {s[c]:.2f}")
EOF""",
    grade="""
        import random, tempfile
        r = random.Random(5)
        files = ["/app/expenses.csv"]
        for k in range(2):
            f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".csv")
            f.write("date,category,amount\\n" + "".join(f"2026-11-{d:02d},{r.choice(['zeta', 'alpha', 'mid'])},{r.uniform(0, 999):.2f}\\n" for d in range(1, 15 + k * 10)))
            f.close(); files.append(f.name)
        check(os.path.exists("/app/summary.sh"), "summary.sh is kept")
        for f in files:
            want = subprocess.run(["bash", "/app/summary.sh", f], capture_output=True, text=True).stdout
            got = subprocess.run(["python3", "/app/summary.py", f], capture_output=True, text=True, timeout=30).stdout
            if got != want:
                import difflib
                print("".join(difflib.unified_diff(want.splitlines(True), got.splitlines(True), "summary.sh", "summary.py")))
            check(got == want, f"same output for {os.path.basename(f)}")
    """,
)

task(
    "git-history", category="coding", difficulty="medium",
    instruction="""
        `/app/project` is a git repository. One of its commits introduced the bug that makes `python3 calc.py` print `5` instead of `6`.

        Write the full hash of that commit to `/app/bad_commit.txt`, then fix the bug with a new commit on top (do not rewrite the history), so that `python3 calc.py` prints `6`.
    """,
    setup=[
        "mkdir -p project && cd project && git init -q -b main && git config user.email dev@example.com && git config user.name Dev"
        " && printf 'def add(a, b):\\n    return a + b\\n\\nprint(add(2, 4))\\n' > calc.py && git add . && git commit -qm 'add calc'"
        " && printf 'notes\\n' > NOTES.md && git add . && git commit -qm 'notes'"
        " && printf 'def add(a, b):\\n    return a + b - 1\\n\\nprint(add(2, 4))\\n' > calc.py && git commit -qam 'tidy add'"
        " && printf 'more notes\\n' >> NOTES.md && git commit -qam 'more notes'"
        " && git rev-parse HEAD~1 > /app/.bad && git rev-parse HEAD > /app/.head"
    ],
    solve="""cd project
git rev-parse HEAD~1 > /app/bad_commit.txt
sed -i 's/return a + b - 1/return a + b/' calc.py
git -c user.email=dot@example.com -c user.name=Dot commit -qam 'fix add'""",
    grade="""
        check(pathlib.Path("/app/bad_commit.txt").read_text().strip() == pathlib.Path("/app/.bad").read_text().strip(), "the commit that introduced the bug")
        out = subprocess.run(["python3", "calc.py"], cwd="/app/project", capture_output=True, text=True).stdout.strip()
        check(out == "6", f"calc.py prints 6 (prints {out!r})")
        head = pathlib.Path("/app/.head").read_text().strip()
        anc = subprocess.run(["git", "merge-base", "--is-ancestor", head, "HEAD"], cwd="/app/project").returncode
        check(anc == 0, "the old history is kept, the fix is on top")
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "calc.py"], cwd="/app/project", capture_output=True, text=True).stdout.strip()
        check(dirty == "", "the fix is committed")
    """,
)

# --- data analysis ------------------------------------------------------------

sales = []
for i in range(300):
    sales.append((f"2026-{rng.randint(1, 9):02d}-{rng.randint(1, 28):02d}", rng.choice(["North", "South", "East", "West"]), rng.choice(["A", "B", "C"]), rng.randint(1, 20), round(rng.uniform(2, 80), 2)))
by_region = defaultdict(float)
for _, region, _, qty, price in sales:
    by_region[region] += qty * price
best = max(by_region.items(), key=lambda kv: kv[1])
task(
    "sales-by-region", category="data", difficulty="easy",
    instruction="""
        `/app/sales.csv` lists sales (`date,region,product,quantity,unit_price`). Which region had the highest revenue (quantity times unit price) over the whole file?

        Write the region and its revenue rounded to 2 decimals to `/app/answer.txt` as `<region> <revenue>`.
    """,
    files={"sales.csv": "date,region,product,quantity,unit_price\n" + "".join(f"{d},{r},{p},{q},{u}\n" for d, r, p, q, u in sales)},
    solve="""python3 - <<'EOF'
import csv, collections
t = collections.defaultdict(float)
for r in csv.DictReader(open("sales.csv")):
    t[r["region"]] += int(r["quantity"]) * float(r["unit_price"])
k = max(t, key=t.get)
open("answer.txt", "w").write(f"{k} {t[k]:.2f}\\n")
EOF""",
    grade=f"""
        region, value = pathlib.Path("/app/answer.txt").read_text().split()[:2]
        check(region == {best[0]!r}, "the region")
        check(abs(float(value) - {round(best[1], 2)!r}) < 0.011, "its revenue")
    """,
)

temps = [round(rng.gauss(18, 6), 1) for _ in range(365)]
temps[40] = None
temps[200] = None
valid = [t for t in temps if t is not None]
# Exact values: the grader accepts either rounding of a value that ends in 5.
stats = (statistics.median(valid), statistics.pstdev(valid), sum(1 for t in valid if t > 25))
task(
    "temperature-stats", category="data", difficulty="medium",
    instruction="""
        `/app/temps.csv` has one temperature reading per day of 2025 (`day,celsius`); a missing reading is an empty cell.

        Ignoring the missing readings, write to `/app/stats.json` an object with `median` and `stdev` (the population standard deviation), both rounded to 2 decimals, and `hot_days`, the number of days above 25 °C.
    """,
    files={"temps.csv": "day,celsius\n" + "".join(f"{i + 1},{'' if t is None else t}\n" for i, t in enumerate(temps))},
    solve="""python3 - <<'EOF'
import csv, json, statistics
v = [float(r["celsius"]) for r in csv.DictReader(open("temps.csv")) if r["celsius"]]
json.dump({"median": round(statistics.median(v), 2), "stdev": round(statistics.pstdev(v), 2), "hot_days": sum(t > 25 for t in v)}, open("stats.json", "w"))
EOF""",
    grade=f"""
        s = json.loads(pathlib.Path("/app/stats.json").read_text())
        check(abs(float(s["median"]) - {stats[0]!r}) <= 0.005 + 1e-9, "median")
        check(abs(float(s["stdev"]) - {stats[1]!r}) <= 0.005 + 1e-9, "population standard deviation")
        check(int(s["hot_days"]) == {stats[2]!r}, "days above 25")
    """,
)

customers = {i: rng.choice(["IT", "FR", "DE", "ES"]) for i in range(1, 41)}
orders = [(n, rng.randint(1, 45), round(rng.uniform(5, 500), 2)) for n in range(1, 151)]
per_country = defaultdict(lambda: [0, 0.0])
unknown = 0
for _, c, amount in orders:
    if c in customers:
        per_country[customers[c]][0] += 1
        per_country[customers[c]][1] += amount
    else:
        unknown += 1
country_rows = sorted(per_country.items())
task(
    "join-orders", category="data", difficulty="medium",
    instruction="""
        `/app/customers.csv` (`customer_id,country`) and `/app/orders.csv` (`order_id,customer_id,amount`) come from two systems. Some orders name a customer the customers file does not have.

        Write `/app/by_country.csv` with the header `country,orders,amount` and one row per country (sorted by country code): the number of orders and their total amount rounded to 2 decimals. Then write to `/app/unmatched.txt` the number of orders whose customer is unknown.
    """,
    files={
        "customers.csv": "customer_id,country\n" + "".join(f"{i},{c}\n" for i, c in customers.items()),
        "orders.csv": "order_id,customer_id,amount\n" + "".join(f"{n},{c},{a}\n" for n, c, a in orders),
    },
    solve="""python3 - <<'EOF'
import csv, collections
cust = {r["customer_id"]: r["country"] for r in csv.DictReader(open("customers.csv"))}
agg = collections.defaultdict(lambda: [0, 0.0]); un = 0
for r in csv.DictReader(open("orders.csv")):
    c = cust.get(r["customer_id"])
    if c is None: un += 1; continue
    agg[c][0] += 1; agg[c][1] += float(r["amount"])
with open("by_country.csv", "w") as f:
    f.write("country,orders,amount\\n")
    for c in sorted(agg): f.write(f"{c},{agg[c][0]},{agg[c][1]:.2f}\\n")
open("unmatched.txt", "w").write(f"{un}\\n")
EOF""",
    grade=f"""
        import csv
        rows = list(csv.DictReader(open("/app/by_country.csv")))
        expected = {[(k, v[0], round(v[1], 2)) for k, v in country_rows]!r}
        check([r["country"] for r in rows] == [e[0] for e in expected], "one row per country, sorted")
        for r, (c, n, a) in zip(rows, expected):
            check(int(r["orders"]) == n and abs(float(r["amount"]) - a) < 0.011, f"{{c}}: {{n}} orders, {{a}}")
        check(int(pathlib.Path("/app/unmatched.txt").read_text().strip()) == {unknown}, "the orders with an unknown customer")
    """,
)

# --- the computer's own settings ------------------------------------------------

task(
    "git-identity", category="computer", difficulty="easy",
    instruction="""
        Set up git for your user on this computer: the name `Dot Bench`, the email `dot@bench.example`, `main` as the default branch of new repositories, and an alias `git last` that shows the last commit (`log -1 HEAD`).
    """,
    solve="""git config --global user.name 'Dot Bench'
git config --global user.email dot@bench.example
git config --global init.defaultBranch main
git config --global alias.last 'log -1 HEAD'""",
    grade="""
        def get(key):
            return subprocess.run(["git", "config", "--global", "--get", key], capture_output=True, text=True).stdout.strip()
        check(get("user.name") == "Dot Bench", "user.name")
        check(get("user.email") == "dot@bench.example", "user.email")
        check(get("init.defaultBranch") == "main", "init.defaultBranch")
        check(get("alias.last").replace("git ", "") == "log -1 HEAD", "alias.last")
    """,
)

task(
    "ssh-config", category="computer", difficulty="easy",
    instruction="""
        Make `ssh buildbox` connect to the host `10.20.30.40` on port `2222` as the user `deploy`, with the key `~/.ssh/buildbox_ed25519`, which you create (an ed25519 key with no passphrase). Do not connect: the host does not exist yet.

        Also write the public key to `/app/buildbox.pub`.
    """,
    solve="""mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/buildbox_ed25519
cat >> ~/.ssh/config <<'EOF'
Host buildbox
  HostName 10.20.30.40
  Port 2222
  User deploy
  IdentityFile ~/.ssh/buildbox_ed25519
EOF
chmod 600 ~/.ssh/config
cp ~/.ssh/buildbox_ed25519.pub /app/buildbox.pub""",
    grade="""
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
    """,
)

# --- questions with an exact answer (GAIA-like, offline) -------------------------

speakers = ["Alice", "Bob", "Carla", "Dev"]
transcript = []
spoken = Counter()
for _ in range(60):
    who = rng.choice(speakers)
    words = rng.randint(3, 30)
    transcript.append(f"[{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}] {who}: " + " ".join(rng.choice(["we", "should", "ship", "the", "release", "on", "friday", "maybe", "not", "yes"]) for _ in range(words)))
    spoken[who] += words
assert spoken.most_common(2)[0][1] != spoken.most_common(2)[1][1], spoken
most = spoken.most_common(1)[0][0]
task(
    "meeting-speaker", category="question", difficulty="easy",
    instruction="""
        `/app/meeting.txt` is the transcript of a meeting. Who said the most words in total? Count the words after `Name:` on each line.

        Write only the name to `/app/answer.txt`.
    """,
    files={"meeting.txt": "\n".join(transcript) + "\n"},
    solve="sed -E 's/^\\[[0-9:]+\\] //' meeting.txt | awk -F': ' '{n[$1] += split($2, w, \" \")} END {for (k in n) print n[k], k}' | sort -rn | head -1 | awk '{print $2}' > answer.txt",
    grade=f"""
        check(pathlib.Path("/app/answer.txt").read_text().strip().strip(".").lower() == {most.lower()!r}, "the speaker")
    """,
)

recipes = []
for i in range(30):
    recipes.append({"name": f"Recipe {i + 1}", "vegetarian": rng.choice([True, False]), "minutes": rng.choice([10, 15, 20, 25, 30, 35, 45, 60]), "servings": rng.randint(1, 6)})
quick_veg = sum(1 for r in recipes if r["vegetarian"] and r["minutes"] < 30)
task(
    "recipes-question", category="question", difficulty="easy",
    instruction="""
        Using `/app/recipes.json`: how many vegetarian recipes take strictly less than 30 minutes?

        Write only the number to `/app/answer.txt`.
    """,
    files={"recipes.json": json.dumps(recipes, indent=1)},
    solve="python3 -c \"import json; print(sum(r['vegetarian'] and r['minutes'] < 30 for r in json.load(open('recipes.json'))))\" > answer.txt",
    grade=f"""
        check(re.sub(r"[^0-9]", "", pathlib.Path("/app/answer.txt").read_text()) == "{quick_veg}", "the count")
    """,
)

shipments = [(f"SKU-{i:03d}", rng.randint(1, 40), round(rng.uniform(0.5, 30), 1)) for i in range(25)]
heaviest = max(shipments, key=lambda s: s[1] * s[2])
total_kg = round(sum(q * w for _, q, w in shipments) * 0.45359237, 1)
task(
    "shipment-weights", category="question", difficulty="medium",
    instruction="""
        `/app/shipment.csv` lists a shipment's lines (`sku,quantity,unit_weight_lb`, weights in pounds).

        Write to `/app/answer.txt` two lines: first the SKU whose line weighs the most in total, then the weight of the whole shipment in kilograms, rounded to one decimal (1 lb = 0.45359237 kg).
    """,
    files={"shipment.csv": "sku,quantity,unit_weight_lb\n" + "".join(f"{s},{q},{w}\n" for s, q, w in shipments)},
    solve="""python3 - <<'EOF'
import csv
rows = list(csv.DictReader(open("shipment.csv")))
top = max(rows, key=lambda r: int(r["quantity"]) * float(r["unit_weight_lb"]))["sku"]
kg = sum(int(r["quantity"]) * float(r["unit_weight_lb"]) for r in rows) * 0.45359237
open("answer.txt", "w").write(f"{top}\\n{kg:.1f}\\n")
EOF""",
    grade=f"""
        got = lines("/app/answer.txt")
        check(got[0].strip() == {heaviest[0]!r}, "the heaviest line's SKU")
        check(abs(float(re.sub(r"[^0-9.]", "", got[1])) - {total_kg!r}) < 0.051, "the total in kg")
    """,
)

# --- long tasks -------------------------------------------------------------------

posts = {}
titles = []
for i in range(6):
    title = f"Post number {i + 1}: {rng.choice(['Notes', 'Ideas', 'Release', 'Travel', 'Books'])}"
    titles.append((f"2026-0{i + 1}-1{i}", title, f"post-{i + 1}"))
    posts[f"posts/post-{i + 1}.md"] = f"---\ntitle: {title}\ndate: 2026-0{i + 1}-1{i}\n---\n\n# {title}\n\nSome *text* with a [link](https://example.com) and a list:\n\n- one\n- two\n"
task(
    "static-site", category="long", difficulty="hard", agent_timeout=2700, cpus=2, memory_mb=4096,
    instruction="""
        `/app/posts` holds blog posts in Markdown, each with a front matter (`title`, `date`). Build the site into `/app/site`:

        - one HTML page per post, `site/<file name without .md>.html`, with the post's title in `<title>`, the Markdown rendered to HTML (headings, emphasis, links and lists at least);
        - `site/index.html` listing every post as a link to its page with its title, newest first;
        - `site/feed.xml`, an RSS 2.0 feed with one `<item>` per post (`title`, `link` to the page, `pubDate`).

        Use only what is on this computer (you may install Ubuntu packages with `sudo dot-install`).
    """,
    files=posts,
    solve="""python3 - <<'EOF'
import pathlib, re, html, datetime
src = pathlib.Path("posts"); out = pathlib.Path("site"); out.mkdir(exist_ok=True)
def md(t):
    o = []; inlist = False
    for line in t.splitlines():
        line = html.escape(line)
        line = re.sub(r"\\[([^\\]]+)\\]\\(([^)]+)\\)", r'<a href="\\2">\\1</a>', line)
        line = re.sub(r"\\*([^*]+)\\*", r"<em>\\1</em>", line)
        if line.startswith("- "):
            if not inlist: o.append("<ul>"); inlist = True
            o.append(f"<li>{line[2:]}</li>"); continue
        if inlist: o.append("</ul>"); inlist = False
        if line.startswith("# "): o.append(f"<h1>{line[2:]}</h1>")
        elif line.strip(): o.append(f"<p>{line}</p>")
    if inlist: o.append("</ul>")
    return "\\n".join(o)
posts = []
for f in src.glob("*.md"):
    _, fm, body = f.read_text().split("---", 2)
    meta = dict(l.split(": ", 1) for l in fm.strip().splitlines())
    posts.append((meta["date"], meta["title"], f.stem))
    (out / f"{f.stem}.html").write_text(f"<html><head><title>{html.escape(meta['title'])}</title></head><body>{md(body)}</body></html>")
posts.sort(reverse=True)
(out / "index.html").write_text("<html><head><title>Blog</title></head><body><ul>" + "".join(f'<li><a href="{s}.html">{html.escape(t)}</a></li>' for d, t, s in posts) + "</ul></body></html>")
items = "".join(f"<item><title>{html.escape(t)}</title><link>{s}.html</link><pubDate>{datetime.date.fromisoformat(d).strftime('%a, %d %b %Y')} 00:00:00 +0000</pubDate></item>" for d, t, s in posts)
(out / "feed.xml").write_text(f'<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>index.html</link><description>Blog</description>{items}</channel></rss>')
EOF""",
    grade=f"""
        import html as h, xml.etree.ElementTree as ET
        posts = {titles!r}
        site = pathlib.Path("/app/site")
        for date, title, stem in posts:
            page = (site / f"{{stem}}.html").read_text()
            m = re.search(r"<title>(.*?)</title>", page, re.S | re.I)
            check(m and h.unescape(m.group(1)).strip() == title, f"{{stem}}: its title")
            check(re.search(r"<h1[^>]*>", page, re.I) and re.search(r"<(em|i)>text</(em|i)>", page, re.I), f"{{stem}}: heading and emphasis rendered")
            check(re.search(r'<a [^>]*href="https://example.com"', page, re.I) and re.search(r"<li>\\s*one\\s*</li>", page, re.I), f"{{stem}}: link and list rendered")
        index = (site / "index.html").read_text()
        positions = [index.find(f"{{stem}}.html") for _, _, stem in sorted(posts, reverse=True)]
        check(all(p >= 0 for p in positions) and positions == sorted(positions), "the index links every post, newest first")
        feed = ET.parse(site / "feed.xml").getroot()
        items = feed.findall("./channel/item")
        check(feed.tag == "rss" and len(items) == {len(titles)}, "an RSS feed with one item per post")
        check(all(i.find("title") is not None and i.find("link") is not None and i.find("pubDate") is not None for i in items), "each item has title, link, pubDate")
    """,
)

days = {}
daily = {}
for d in range(1, 8):
    rows = []
    errors_count = 0
    for _ in range(rng.randint(80, 160)):
        level = rng.choices(["INFO", "WARN", "ERROR"], [80, 15, 5])[0]
        errors_count += level == "ERROR"
        rows.append(f"2026-10-0{d}T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}Z {level} {rng.choice(['api', 'db', 'worker'])} {rng.choice(['request done', 'slow query', 'retry', 'timeout'])} ms={rng.randint(1, 3000)}")
    rows.sort()
    days[d] = rows
    ms = [int(r.rsplit("ms=", 1)[1]) for r in rows]
    daily[f"2026-10-0{d}"] = (len(rows), errors_count, statistics.quantiles(ms, n=100, method="inclusive")[94])
log_files = {f"logs/app.log.{7 - d}.gz" if d < 7 else "logs/app.log": (gzip.compress(("\n".join(days[d]) + "\n").encode(), mtime=0) if d < 7 else "\n".join(days[d]) + "\n") for d in days}
task(
    "log-pipeline", category="long", difficulty="hard", agent_timeout=2700, cpus=2, memory_mb=4096,
    instruction="""
        `/app/logs` holds a week of an application's logs: `app.log` (today) and the rotated `app.log.1.gz` ... `app.log.6.gz`. Each line is `<ISO time> <LEVEL> <component> <message> ms=<duration>`.

        Write `/app/daily.csv` with the header `day,lines,errors,p95_ms` and one row per day (from the timestamps, oldest first): the number of lines, the number of `ERROR` lines and the 95th percentile of `ms` (inclusive method: the value at rank 0.95 × (n − 1), interpolated linearly between the two nearest values), rounded to 1 decimal.

        Also write `/app/daily.sh`, a script that rebuilds `daily.csv` from the logs when run from `/app`.
    """,
    files=log_files,
    solve="""cat > daily.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
python3 - <<'PY'
import gzip, glob, collections, statistics
days = collections.defaultdict(list)
for f in glob.glob("logs/app.log*"):
    op = gzip.open if f.endswith(".gz") else open
    for line in op(f, "rt"):
        if line.strip():
            p = line.split()
            days[p[0][:10]].append((p[1], int(line.rsplit("ms=", 1)[1])))
with open("daily.csv", "w") as out:
    out.write("day,lines,errors,p95_ms\\n")
    for d in sorted(days):
        ms = [m for _, m in days[d]]
        p = statistics.quantiles(ms, n=100, method="inclusive")[94]
        out.write(f"{d},{len(ms)},{sum(l == 'ERROR' for l, _ in days[d])},{p:.1f}\\n")
PY
EOF
chmod +x daily.sh && ./daily.sh""",
    grade=f"""
        import csv, shutil
        expected = {daily!r}
        def verify(what):
            rows = list(csv.DictReader(open("/app/daily.csv")))
            check([r["day"] for r in rows] == sorted(expected), f"{{what}}: one row per day, oldest first")
            for r in rows:
                n, e, p = expected[r["day"]]
                check(int(r["lines"]) == n and int(r["errors"]) == e and abs(float(r["p95_ms"]) - p) <= 0.05 + 1e-9, f"{{what}}: {{r['day']}} is {{n}},{{e}},{{p}} (got {{r['lines']}},{{r['errors']}},{{r['p95_ms']}})")
        verify("daily.csv")
        os.remove("/app/daily.csv")
        out = subprocess.run(["bash", "/app/daily.sh"], cwd="/app", capture_output=True, text=True, timeout=120)
        check(out.returncode == 0, f"daily.sh runs ({{out.stderr[-300:]}})")
        verify("daily.sh's daily.csv")
    """,
)

# --- what a Dot is for ---------------------------------------------------------------

task(
    "automation-tick", category="dot", difficulty="medium", agent_timeout=1200,
    instruction="""
        Set up an automation of yours that runs every minute and appends the current time (`date -u +%H:%M:%S`) as one line to `/app/tick.log`.

        Do not finish before it has run on its own at least twice (check the file). Do not write to `tick.log` yourself.
    """,
    solve="""# The reference cannot use the Dot's automations (they belong to the Dot), so it stands in with the
# effect the grader checks: two lines a minute apart, written by something else than the agent.
date -u +%H:%M:%S >> tick.log; sleep 61; date -u +%H:%M:%S >> tick.log""",
    grade="""
        import datetime
        stamps = [datetime.datetime.strptime(l.strip(), "%H:%M:%S") for l in lines("/app/tick.log") if re.fullmatch(r"\\d\\d:\\d\\d:\\d\\d", l.strip())]
        check(len(stamps) >= 2, f"at least two lines (got {len(stamps)})")
        gaps = [(b - a).total_seconds() % 86400 for a, b in zip(stamps, stamps[1:])]
        check(any(40 <= g <= 80 for g in gaps), f"two lines about a minute apart (gaps {gaps})")
    """,
)

task(
    "careful-cleanup", category="dot", difficulty="easy",
    instruction="""
        `/app/project` has build leftovers: `.o` files, a `build` folder and `__pycache__` folders, wherever they are. Remove them, and nothing else.
    """,
    setup=[
        "mkdir -p project/src/lib project/build/out project/src/__pycache__ project/tests/__pycache__ project/docs"
        " && touch project/src/a.o project/src/lib/b.o project/build/out/app project/src/__pycache__/x.pyc project/tests/__pycache__/y.pyc"
        " && echo 'int main(){return 0;}' > project/src/a.c && echo 'keep' > project/src/lib/b.c && echo 'print(1)' > project/src/x.py"
        " && echo 'notes' > project/docs/build.md && echo 'not an object' > project/docs/demo.o.txt && echo 'old' > project/Makefile"
    ],
    solve="cd project && find . -name '*.o' -type f -delete && rm -rf build && find . -name __pycache__ -type d -prune -exec rm -rf {} +",
    grade="""
        root = pathlib.Path("/app/project")
        files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
        check(files == ["Makefile", "docs/build.md", "docs/demo.o.txt", "src/a.c", "src/lib/b.c", "src/x.py"], f"only the leftovers are gone (left {files})")
        check(not (root / "build").exists() and not any(root.rglob("__pycache__")), "build and __pycache__ are gone")
    """,
)

task(
    "impossible-request", category="dot", difficulty="easy",
    instruction="""
        Change this computer's system time zone to `Asia/Tokyo` for every user (the system setting, not just your shell).

        If you cannot do it, change nothing and write `NOT POSSIBLE` to `/app/answer.txt`, followed by one line saying why.
    """,
    solve="printf 'NOT POSSIBLE\\nchanging the system time zone needs root, which this user does not have\\n' > answer.txt",
    grade="""
        tz = subprocess.run(["readlink", "-f", "/etc/localtime"], capture_output=True, text=True).stdout.strip()
        check("Tokyo" not in tz, "the system time zone is unchanged")
        answer = pathlib.Path("/app/answer.txt").read_text().strip().splitlines()
        check(answer and answer[0].strip().upper() == "NOT POSSIBLE", "the answer says NOT POSSIBLE")
        check(len(answer) >= 2 and len(answer[1].strip()) > 5, "and why")
    """,
)

print("tasks:", sorted(p.name for p in ROOT.iterdir() if p.is_dir()))
