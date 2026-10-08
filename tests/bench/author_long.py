"""Writes the long benchmark tasks (two to three hours each) under the directory given, in Harbor's format.

    python author_long.py tests/bench/tasks-long

Building something or researching something, each with a grader that checks the result itself: hidden test
programs, published reference counts, a service killed and restarted, facts that do not change, and
fraud planted in generated data. The reference solutions are in references/; the expected answers are
computed here from them.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFS = HERE / "references"
ROOT = Path(sys.argv[1])

TOML = """schema_version = "1.4"

[metadata]
category = "{category}"
difficulty = "hard"

[verifier]
timeout_sec = {verifier_timeout}

[agent]
timeout_sec = 10800.0

[environment]
build_timeout_sec = 1800.0
cpus = 2
memory_mb = 4096
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

GRADE_HEAD = '''"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)
'''


def task(name, *, category, instruction, files=None, setup=(), solve, grade, verifier_timeout=900, tests_files=None):
    base = ROOT / name
    for sub in ("environment", "solution", "tests"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    (base / "task.toml").write_text(TOML.format(category=category, verifier_timeout=float(verifier_timeout)), encoding="utf-8", newline="\n")
    (base / "instruction.md").write_text(textwrap.dedent(instruction).strip() + "\n", encoding="utf-8", newline="\n")
    docker = ["FROM ubuntu:24.04", "WORKDIR /app"]
    if files:
        for rel, content in files.items():
            target = base / "environment" / "files" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", newline="\n")
        docker.append("COPY files/ /app/")
    docker += [f"RUN {step}" for step in setup]
    (base / "environment" / "Dockerfile").write_text("\n".join(docker) + "\n", encoding="utf-8", newline="\n")
    (base / "solution" / "solve.sh").write_text("#!/bin/bash\nset -euo pipefail\ncd /app\n" + textwrap.dedent(solve).strip() + "\n", encoding="utf-8", newline="\n")
    (base / "tests" / "test.sh").write_text(TEST_SH, encoding="utf-8", newline="\n")
    (base / "tests" / "grade.py").write_text(GRADE_HEAD + "\n" + textwrap.dedent(grade).strip() + "\n", encoding="utf-8", newline="\n")
    for rel, content in (tests_files or {}).items():
        (base / "tests" / rel).write_text(content, encoding="utf-8", newline="\n")


def heredoc(path, content):
    """A solve.sh step that writes `content` to `path` (content without the marker line)."""
    assert "\nREFERENCE_EOF\n" not in content
    return f"cat > {path} <<'REFERENCE_EOF'\n{content.rstrip()}\nREFERENCE_EOF\n"


# --- chess-perft ------------------------------------------------------------------------------

PUBLISHED = [
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 5, 4865609),
    ("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 4, 4085603),
    ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624),
    ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333),
    ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 4, 2103487),
]
HIDDEN_FENS = [
    ("r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", 3),
    ("rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6 0 2", 4),
    ("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", 4),
    ("8/P7/8/8/8/8/7p/K6k w - - 0 1", 5),
]


def perft(fen, depth):
    out = subprocess.run([sys.executable, str(REFS / "perft.py"), fen, str(depth)], capture_output=True, text=True, check=True)
    return int(out.stdout)


hidden = [(fen, depth, perft(fen, depth)) for fen, depth in HIDDEN_FENS]
task(
    "chess-perft", category="build", verifier_timeout=7200,
    instruction="""
        Write a chess move generator. `/app/perft "<FEN>" <depth>` must print only the number of legal move sequences of `<depth>` plies from the position given in Forsyth-Edwards Notation (the "perft" count): every rule counts, including castling (not out of, through or into check), en passant, promotion to each of the four pieces, and the 50-move and repetition rules do not.

        Use any language available on this computer (you may install Ubuntu packages with `sudo dot-install`); make `/app/perft` executable.

        It will be checked on positions you have not seen, at depths up to 5, and each count must take less than 15 minutes on this computer. Do not hard-code results.
    """,
    solve=heredoc("perft", (REFS / "perft.py").read_text(encoding="utf-8")) + "chmod +x perft",
    grade=f"""
        cases = {[*PUBLISHED, *hidden]!r}
        check(os.access("/app/perft", os.X_OK), "/app/perft is executable")
        for fen, depth, count in sorted(cases, key=lambda c: c[2]):
            started = time.time()
            try:
                out = subprocess.run(["/app/perft", fen, str(depth)], capture_output=True, text=True, timeout=900)
            except subprocess.TimeoutExpired:
                check(False, f"{{fen}} depth {{depth}} within 15 minutes")
            got = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
            check(got == str(count), f"{{fen}} depth {{depth}}: {{count}} (got {{got!r}} in {{time.time() - started:.0f}} s)")
    """,
)

# --- lisp-interpreter -----------------------------------------------------------------------------

task(
    "lisp-interpreter", category="build", verifier_timeout=1800,
    instruction="""
        Write an interpreter for a small Scheme. `/app/lisp FILE` runs the program in FILE and prints what it displays. Use any language available on this computer and make `/app/lisp` executable.

        The language:
        - integers of any size, decimals, `#t` and `#f`, strings with the escapes `\\n`, `\\t`, `\\"` and `\\\\`, symbols, lists, `'x` for `(quote x)`, and `;` comments;
        - special forms `define` (also `(define (f a b) ...)` and `(define (f . args) ...)`), `lambda` (also `(lambda args ...)`), `if`, `cond` with `else`, `let`, `let*`, `letrec`, `begin`, `set!`, `and`, `or`, `quote`;
        - procedures `+ - * /` (`/` gives an integer when the division is exact, a decimal otherwise), `quotient`, `remainder`, `modulo`, `= < > <= >=` (with any number of arguments), `abs`, `min`, `max`, `not`, `eq?`, `equal?`, `null?`, `pair?`, `list?`, `number?`, `string?`, `symbol?`, `procedure?`, `boolean?`, `cons`, `car`, `cdr`, `list`, `length`, `append`, `reverse`, `map`, `filter`, `apply`, `display`, `newline`, `error`, `string-append`, `string-length`, `number->string`, `symbol->string`;
        - `display` writes values as Scheme does: `#t`, `(1 (2 3))`, `(1 . 2)`, `()`, a string without quotes, but strings inside a list with them;
        - calls in tail position must not grow the stack: a loop of a million iterations written as a tail-recursive procedure must work, and so must an ordinary (non-tail) recursion 5000 calls deep;
        - an error (an undefined variable, calling something that is not a procedure, `car` of an empty list, a division by zero, a call of `error`) stops the program: what it displayed before stays printed on standard output, `error: ` and a message go to standard error, and the exit code is 1. Otherwise the exit code is 0.

        It will be checked with programs you have not seen.
    """,
    solve=heredoc("lisp", (REFS / "lisp.py").read_text(encoding="utf-8")) + "chmod +x lisp",
    grade="""
        import tempfile
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from lisp_cases import CASES
        check(os.access("/app/lisp", os.X_OK), "/app/lisp is executable")
        passed = 0
        for name, program, stdout, code, err in CASES:
            f = tempfile.NamedTemporaryFile("w", suffix=".scm", delete=False); f.write(program); f.close()
            try:
                r = subprocess.run(["/app/lisp", f.name], capture_output=True, text=True, timeout=120)
                ok = r.stdout == stdout and r.returncode == code and err.lower() in r.stderr.lower()
                detail = f"stdout {r.stdout[:120]!r} exit {r.returncode}"
            except subprocess.TimeoutExpired:
                ok, detail = False, "timed out"
            print(("ok" if ok else "FAIL") + ":", name, "" if ok else detail, flush=True)
            passed += ok
        check(passed == len(CASES), f"{passed} of {len(CASES)} programs")
    """,
    tests_files={"lisp_cases.py": (REFS / "lisp_cases.py").read_text(encoding="utf-8")},
)

# --- kv-store ---------------------------------------------------------------------------------------

START_SH = """#!/bin/bash
# Starts the server in the background and returns once it answers.
cd "$(dirname "$0")"
nohup setsid python3 kvserver.py > server.log 2>&1 < /dev/null &
echo $! > server.pid
for i in $(seq 100); do
  curl -s -o /dev/null http://127.0.0.1:7070/stats && exit 0
  sleep 0.1
done
exit 1
"""
task(
    "kv-store", category="build", verifier_timeout=1800,
    instruction="""
        Build a small key-value database server in `/app/kv`. `/app/kv/start.sh` must start it in the background on 127.0.0.1 port 7070, write the server's process id to `/app/kv/server.pid`, and return once the server answers. It keeps its data in `/app/kv/data`.

        Its HTTP API:
        - `PUT /keys/<key>` stores the request body (any bytes, up to 2 MB) as the key's value: 201 when the key was new, 200 when it replaced a value. A header `X-TTL: <seconds>` makes the key expire that many seconds later;
        - `GET /keys/<key>`: 200 with the value exactly as stored, or 404 (also once the key expired);
        - `DELETE /keys/<key>`: 204, or 404 when there is no such key;
        - `GET /keys?prefix=<p>`: 200 with a JSON array of the live keys starting with `p`, sorted;
        - `GET /stats`: 200 with `{"keys": <number of live keys>}`.

        A key in the URL is percent-encoded (it may hold `/` or spaces). Many clients may write at once.

        Durability: once a `PUT` or `DELETE` has been answered, its effect must survive the server being killed with `kill -9` at any moment, and `start.sh` being run again.
    """,
    solve="mkdir -p kv\n" + heredoc("kv/kvserver.py", (REFS / "kvserver.py").read_text(encoding="utf-8")) + heredoc("kv/start.sh", START_SH) + "chmod +x kv/start.sh\nkv/start.sh",
    grade=r"""
        import random, signal, threading, urllib.error, urllib.parse, urllib.request
        BASE = "http://127.0.0.1:7070"

        def call(method, path, body=None, headers=None):
            req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.read()

        def key(k):
            return "/keys/" + urllib.parse.quote(k, safe="")

        def kill():
            try:
                pid = int(pathlib.Path("/app/kv/server.pid").read_text().strip())
                os.kill(pid, signal.SIGKILL)
            except (OSError, ValueError):
                pass
            time.sleep(1)

        def start():
            r = subprocess.run(["/app/kv/start.sh"], capture_output=True, text=True, timeout=60)
            check(r.returncode == 0, f"start.sh starts the server ({r.stderr[-200:]})")

        kill()
        start()
        check(call("PUT", key("a"), b"1")[0] == 201, "PUT a new key: 201")
        check(call("PUT", key("a"), b"2")[0] == 200, "PUT over it: 200")
        check(call("GET", key("a")) == (200, b"2"), "GET gives the last value")
        check(call("GET", key("missing"))[0] == 404, "GET of a missing key: 404")
        check(call("PUT", key("gone"), b"x")[0] == 201 and call("DELETE", key("gone"))[0] == 204, "DELETE: 204")
        check(call("DELETE", key("gone"))[0] == 404 and call("GET", key("gone"))[0] == 404, "a deleted key is gone")
        odd = "dir/sub file?&=%"
        check(call("PUT", key(odd), b"odd")[0] == 201 and call("GET", key(odd)) == (200, b"odd"), "a key with / and spaces")
        blob = random.Random(1).randbytes(1_500_000)
        check(call("PUT", key("blob"), blob)[0] == 201 and call("GET", key("blob")) == (200, blob), "a 1.5 MB binary value")
        for k in ("user:1", "user:2", "item:1"):
            call("PUT", key(k), k.encode())
        status, body = call("GET", "/keys?prefix=" + urllib.parse.quote("user:"))
        check(status == 200 and json.loads(body) == ["user:1", "user:2"], "prefix listing, sorted")
        check(call("PUT", key("short"), b"t", {"X-TTL": "2"})[0] == 201 and call("GET", key("short"))[0] == 200, "a key with a TTL")
        time.sleep(3)
        check(call("GET", key("short"))[0] == 404, "it expires")
        check("short" not in json.loads(call("GET", "/keys?prefix=")[1]), "an expired key is not listed")
        errors = []
        def writer(t):
            for i in range(50):
                s, _ = call("PUT", key(f"c-{t}-{i}"), f"{t}-{i}".encode())
                if s != 201:
                    errors.append((t, i, s))
        threads = [threading.Thread(target=writer, args=(t,)) for t in range(20)]
        for th in threads: th.start()
        for th in threads: th.join()
        check(not errors, f"1000 writes from 20 clients at once ({errors[:3]})")
        call("PUT", key("last"), b"acked")
        kill()
        start()
        check(call("GET", key("last")) == (200, b"acked"), "the last acknowledged write survives kill -9")
        check(all(call("GET", key(f"c-{t}-{i}")) == (200, f"{t}-{i}".encode()) for t in range(20) for i in range(50)), "every concurrent write survives kill -9")
        check(call("GET", key("a")) == (200, b"2") and call("GET", key("blob")) == (200, blob), "replaced and binary values survive")
        check(call("GET", key("gone"))[0] == 404 and call("GET", key("short"))[0] == 404, "deleted and expired keys stay gone")
        status, body = call("GET", "/stats")
        check(status == 200 and json.loads(body) == {"keys": 1000 + 7}, f"stats counts the live keys ({body!r})")
        kill()
    """,
)

# --- language-history (research) ---------------------------------------------------------------------

LANGUAGES = {
    "C": (1972, ["Ritchie"]), "C++": (1985, ["Stroustrup"]), "Erlang": (1986, ["Armstrong", "Virding", "Williams"]),
    "Perl": (1987, ["Wall"]), "Python": (1991, ["Rossum"]), "Lua": (1993, ["Ierusalimschy", "Celes", "Figueiredo"]),
    "Java": (1995, ["Gosling"]), "JavaScript": (1995, ["Eich"]), "PHP": (1995, ["Lerdorf"]), "Ruby": (1995, ["Matsumoto"]),
    "Scala": (2004, ["Odersky"]), "Go": (2009, ["Griesemer", "Pike", "Thompson"]), "Dart": (2011, ["Bak", "Lund"]),
    "Kotlin": (2011, ["JetBrains", "Breslav"]), "Elixir": (2012, ["Valim"]), "Julia": (2012, ["Bezanson", "Karpinski", "Shah", "Edelman"]),
    "TypeScript": (2012, ["Hejlsberg", "Microsoft"]), "Swift": (2014, ["Lattner", "Apple"]),
}
CORE_EDGES = [("C", "C++"), ("C++", "Java"), ("Java", "JavaScript"), ("Erlang", "Elixir"), ("Ruby", "Elixir"), ("JavaScript", "TypeScript"),
              ("Java", "Scala"), ("C", "Go"), ("Perl", "Ruby"), ("Java", "Kotlin"), ("Python", "Julia"), ("Perl", "PHP")]
KNOWN_EDGES = CORE_EDGES + [
    ("C", "Python"), ("C++", "Python"), ("Perl", "Python"), ("Java", "Python"), ("C++", "Ruby"), ("Lua", "Ruby"), ("Python", "Ruby"),
    ("C", "PHP"), ("C++", "PHP"), ("Java", "PHP"), ("JavaScript", "PHP"), ("C", "Perl"), ("C++", "Perl"), ("Python", "Perl"), ("C++", "Lua"),
    ("Erlang", "Scala"), ("Python", "Kotlin"), ("Scala", "Kotlin"), ("JavaScript", "Kotlin"), ("Erlang", "Dart"), ("JavaScript", "Dart"),
    ("Python", "Dart"), ("Ruby", "Dart"), ("TypeScript", "Dart"), ("Java", "Dart"), ("C", "Julia"), ("Lua", "Julia"), ("Perl", "Julia"),
    ("Ruby", "Julia"), ("Java", "TypeScript"), ("Kotlin", "Swift"), ("Python", "Swift"), ("Ruby", "Swift"), ("Scala", "Swift"),
    ("C", "Java"), ("C", "Lua"), ("C", "Ruby"), ("Python", "Go"), ("C++", "Go"), ("Java", "Go"), ("C++", "Scala"), ("C", "Swift"),
    ("C++", "Swift"), ("JavaScript", "Swift"), ("C", "JavaScript"), ("Python", "JavaScript"), ("Python", "Scala"), ("C++", "Kotlin"),
    ("Erlang", "Go"), ("Java", "C++"), ("Scala", "Elixir"), ("Python", "Elixir"), ("Ruby", "Python"), ("Ruby", "Kotlin"),
    ("Swift", "Kotlin"), ("Go", "Swift"), ("Go", "Dart"), ("C++", "Dart"), ("C++", "Java"), ("Java", "Swift"), ("Erlang", "Julia"),
]
SOURCES = {name: f"https://en.wikipedia.org/wiki/{name.replace('C++', 'C%2B%2B').replace(' ', '_')}_(programming_language)" for name in LANGUAGES}
SOURCES.update({"Python": "https://www.python.org/doc/essays/foreword/", "Java": "https://www.oracle.com/java/moved-by-java/timeline/",
                "Ruby": "https://www.ruby-lang.org/en/about/", "Lua": "https://www.lua.org/history.html", "Elixir": "https://elixir-lang.org/",
                "Julia": "https://julialang.org/blog/2012/02/why-we-created-julia/", "Go": "https://go.dev/doc/faq", "Scala": "https://www.scala-lang.org/"})
CREATORS = {
    "C": "Dennis Ritchie", "C++": "Bjarne Stroustrup", "Erlang": "Joe Armstrong; Robert Virding; Mike Williams", "Perl": "Larry Wall",
    "Python": "Guido van Rossum", "Lua": "Roberto Ierusalimschy; Waldemar Celes; Luiz Henrique de Figueiredo", "Java": "James Gosling",
    "JavaScript": "Brendan Eich", "PHP": "Rasmus Lerdorf", "Ruby": "Yukihiro Matsumoto", "Scala": "Martin Odersky",
    "Go": "Robert Griesemer; Rob Pike; Ken Thompson", "Dart": "Lars Bak; Kasper Lund", "Kotlin": "JetBrains (Andrey Breslav)",
    "Elixir": "José Valim", "Julia": "Jeff Bezanson; Stefan Karpinski; Viral B. Shah; Alan Edelman", "TypeScript": "Anders Hejlsberg (Microsoft)",
    "Swift": "Chris Lattner (Apple)",
}
order = sorted(LANGUAGES, key=lambda n: (LANGUAGES[n][0], n))
csv_lines = ["language,year,creators"] + [f'{n},{LANGUAGES[n][0]},"{CREATORS[n]}"' for n in order]
dot = "digraph influences {\n" + "".join(f'  "{a}" -> "{b}";\n' for a, b in CORE_EDGES + KNOWN_EDGES[12:20]) + "}\n"
sections = []
for n in order:
    year, _ = LANGUAGES[n]
    before = [a for a, b in KNOWN_EDGES if b == n][:3]
    after = [b for a, b in KNOWN_EDGES if a == n][:3]
    sections.append(
        f"## {n}\n\n{n} first appeared in {year}. It was created by {CREATORS[n]}. "
        f"Its design drew on {', '.join(before) if before else 'languages outside this list'}, and in turn it shaped "
        f"{', '.join(after) if after else 'languages outside this list'}. "
        "Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, "
        "and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. "
        f"The account here follows the language's own documentation and its encyclopedia entry ({SOURCES[n]}).\n"
    )
report = "# Eighteen programming languages and how they influenced each other\n\n" + "\n".join(sections)
assert len(report.split()) >= 1500, len(report.split())
task(
    "language-history", category="research",
    instruction=f"""
        Research the history of these programming languages: {", ".join(LANGUAGES)}. Use the web as you see fit.

        Write:
        - `/app/languages.csv` with the header `language,year,creators` and one row per language, with the year the language first appeared publicly and its creators (people; a company when no person is credited), names separated by `;`, the rows sorted by year and then by name. Write each language's name exactly as above;
        - `/app/influences.dot`, a Graphviz `digraph` with an edge `"A" -> "B"` for each documented case of a language A of the list influencing a language B of the list (at least 15 edges, node names quoted and written exactly as above);
        - `/app/report.md`, a report of at least 1500 words with a `## <language>` section for each language, telling its origin and influences, and citing the sources you used (at least one URL per section, from at least five different websites overall).
    """,
    solve=heredoc("languages.csv", "\n".join(csv_lines)) + heredoc("influences.dot", dot) + heredoc("report.md", report),
    verifier_timeout=300,
    grade=f"""
        import csv
        LANGUAGES = {LANGUAGES!r}
        CORE = {CORE_EDGES!r}
        KNOWN = set(map(tuple, {KNOWN_EDGES!r}))
        rows = list(csv.DictReader(open("/app/languages.csv", encoding="utf-8")))
        names = [r["language"].strip() for r in rows]
        check(sorted(names) == sorted(LANGUAGES), f"one row per language, named as given ({{names}})")
        years = [int(r["year"]) for r in rows]
        check(list(zip(years, names)) == sorted(zip(years, names)), "rows sorted by year, then name")
        right_years = sum(int(r["year"]) == LANGUAGES[r["language"].strip()][0] for r in rows)
        check(right_years >= 16, f"the first-appearance years ({{right_years}} of 18 right, 16 needed)")
        right_people = sum(any(k.lower() in r["creators"].lower() for k in LANGUAGES[r["language"].strip()][1]) for r in rows)
        check(right_people >= 16, f"the creators ({{right_people}} of 18 right, 16 needed)")
        dot = pathlib.Path("/app/influences.dot").read_text(encoding="utf-8")
        check(re.search(r"digraph", dot) is not None, "influences.dot is a digraph")
        edges = set(re.findall(r'"([^"]+)"\\s*->\\s*"([^"]+)"', dot))
        check(len(edges) >= 15, f"at least 15 edges ({{len(edges)}})")
        check(all(a in LANGUAGES and b in LANGUAGES for a, b in edges), "edges only between the listed languages, named as given")
        recall = sum(e in edges for e in CORE)
        check(recall >= 8, f"the best-known influences ({{recall}} of {{len(CORE)}}, 8 needed)")
        precision = sum(e in KNOWN for e in edges) / len(edges)
        check(precision >= 0.7, f"documented influences ({{precision:.0%}} of the edges, 70% needed)")
        report = pathlib.Path("/app/report.md").read_text(encoding="utf-8")
        check(len(report.split()) >= 1500, f"at least 1500 words ({{len(report.split())}})")
        def language_of(heading):
            # "C (1972)", "1. Python", "Go: ..." or "Swift - ..." name the language before the extras.
            name = re.sub(r"^\\d+[.)]\\s*", "", heading.strip().strip("*_`"))
            return re.split(r"\\s+[(\\[:|\\u2013\\u2014-]|:", name)[0].strip().strip("*_`")
        parts = re.split(r"(?m)^##+\\s+", report)[1:]
        sections = {{language_of(p.splitlines()[0]): p for p in parts}}
        missing = sorted(set(LANGUAGES) - set(sections))
        check(not missing, f"a section per language (missing {{missing}}; headings {{sorted(sections)[:30]}})")
        check(all(re.search(r"https?://", sections[n]) for n in LANGUAGES), "a source URL in each language's section")
        domains = {{re.sub(r"^www\\.", "", d.lower()) for d in re.findall(r"https?://([^/\\s)\\]>]+)", report)}}
        check(len(domains) >= 5, f"sources from at least five websites ({{sorted(domains)}})")
    """,
)

# --- fraud-investigation (data) ---------------------------------------------------------------------

with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([sys.executable, str(REFS / "fraud_gen.py")], cwd=tmp, check=True)
    digest = hashlib.md5(Path(tmp, "transactions.csv").read_bytes()).hexdigest()
    subprocess.run([sys.executable, str(REFS / "fraud_find.py")], cwd=tmp, check=True)
    findings = json.loads(Path(tmp, "findings.json").read_text())
task(
    "fraud-investigation", category="data",
    instruction="""
        `/app/transactions.csv` holds a month of card transactions (`tx_id,timestamp,card_id,account_id,merchant_id,amount,currency,country,type`, `type` being `purchase` or `refund`, times in UTC). Investigate it for four kinds of fraud, which count only purchases unless said otherwise:

        1. card testing: a card with at least 10 purchases of less than 2.00, all within 10 minutes (the last at most 600 seconds after the first);
        2. impossible travel: an account with two purchases in different countries less than 60 minutes apart;
        3. duplicate charges: a purchase made with the same card, at the same merchant, for the same amount as an earlier purchase at most 120 seconds before it (report the later one);
        4. refund abuse: a merchant with at least 50 transactions (purchases and refunds) of which more than 30% are refunds.

        Write:
        - `/app/findings.json`: `{"card_testing": [card ids], "impossible_travel": [account ids], "duplicate_charges": [tx ids], "refund_merchants": [merchant ids]}`, each list sorted;
        - `/app/analyze.py`, which rebuilds `findings.json` from `transactions.csv` when run from `/app` with `python3 analyze.py`;
        - `/app/report.md`, a report for the fraud team: how many cases of each kind, the largest ones, how you found them, and what they should look at first.
    """,
    files={"gen.py": (REFS / "fraud_gen.py").read_text(encoding="utf-8")},
    setup=["python3 gen.py && rm gen.py"],
    solve=heredoc("analyze.py", (REFS / "fraud_find.py").read_text(encoding="utf-8")) + "python3 analyze.py\n" + heredoc(
        "report.md",
        "# Fraud review\n\n" + "\n".join(f"- {k.replace('_', ' ')}: {len(v)} cases" for k, v in findings.items())
        + "\n\nFound with the rules of the review, applied to every purchase in time order; the duplicate charges and the card testing should be looked at first, since they are money taken now.\n",
    ),
    verifier_timeout=900,
    grade=f"""
        import hashlib, shutil
        EXPECTED = {findings!r}
        check(hashlib.md5(open("/app/transactions.csv", "rb").read()).hexdigest() == {digest!r}, "the data is the task's (unchanged)")
        def verify(what):
            got = json.loads(pathlib.Path("/app/findings.json").read_text())
            for kind, expected in EXPECTED.items():
                found = set(got.get(kind, []))
                hit = len(found & set(expected))
                check(hit == len(expected) and len(found) == len(expected), f"{{what}}: {{kind}} ({{hit}} of {{len(expected)}} found, {{len(found) - hit}} wrong)")
        verify("findings.json")
        shutil.move("/app/findings.json", "/app/findings.json.bak")
        r = subprocess.run(["python3", "analyze.py"], cwd="/app", capture_output=True, text=True, timeout=600)
        check(r.returncode == 0, f"analyze.py runs ({{r.stderr[-300:]}})")
        verify("analyze.py's findings.json")
        report = pathlib.Path("/app/report.md").read_text(encoding="utf-8")
        counts = [str(len(v)) for v in EXPECTED.values()]
        check(sum(c in re.findall(r"\\d+", report) for c in counts) >= 3, "the report gives the numbers of cases")
    """,
)

print("tasks:", sorted(p.name for p in ROOT.iterdir() if p.is_dir()))
