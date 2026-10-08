"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)

import csv
LANGUAGES = {'C': (1972, ['Ritchie']), 'C++': (1985, ['Stroustrup']), 'Erlang': (1986, ['Armstrong', 'Virding', 'Williams']), 'Perl': (1987, ['Wall']), 'Python': (1991, ['Rossum']), 'Lua': (1993, ['Ierusalimschy', 'Celes', 'Figueiredo']), 'Java': (1995, ['Gosling']), 'JavaScript': (1995, ['Eich']), 'PHP': (1995, ['Lerdorf']), 'Ruby': (1995, ['Matsumoto']), 'Scala': (2004, ['Odersky']), 'Go': (2009, ['Griesemer', 'Pike', 'Thompson']), 'Dart': (2011, ['Bak', 'Lund']), 'Kotlin': (2011, ['JetBrains', 'Breslav']), 'Elixir': (2012, ['Valim']), 'Julia': (2012, ['Bezanson', 'Karpinski', 'Shah', 'Edelman']), 'TypeScript': (2012, ['Hejlsberg', 'Microsoft']), 'Swift': (2014, ['Lattner', 'Apple'])}
CORE = [('C', 'C++'), ('C++', 'Java'), ('Java', 'JavaScript'), ('Erlang', 'Elixir'), ('Ruby', 'Elixir'), ('JavaScript', 'TypeScript'), ('Java', 'Scala'), ('C', 'Go'), ('Perl', 'Ruby'), ('Java', 'Kotlin'), ('Python', 'Julia'), ('Perl', 'PHP')]
KNOWN = set(map(tuple, [('C', 'C++'), ('C++', 'Java'), ('Java', 'JavaScript'), ('Erlang', 'Elixir'), ('Ruby', 'Elixir'), ('JavaScript', 'TypeScript'), ('Java', 'Scala'), ('C', 'Go'), ('Perl', 'Ruby'), ('Java', 'Kotlin'), ('Python', 'Julia'), ('Perl', 'PHP'), ('C', 'Python'), ('C++', 'Python'), ('Perl', 'Python'), ('Java', 'Python'), ('C++', 'Ruby'), ('Lua', 'Ruby'), ('Python', 'Ruby'), ('C', 'PHP'), ('C++', 'PHP'), ('Java', 'PHP'), ('JavaScript', 'PHP'), ('C', 'Perl'), ('C++', 'Perl'), ('Python', 'Perl'), ('C++', 'Lua'), ('Erlang', 'Scala'), ('Python', 'Kotlin'), ('Scala', 'Kotlin'), ('JavaScript', 'Kotlin'), ('Erlang', 'Dart'), ('JavaScript', 'Dart'), ('Python', 'Dart'), ('Ruby', 'Dart'), ('TypeScript', 'Dart'), ('Java', 'Dart'), ('C', 'Julia'), ('Lua', 'Julia'), ('Perl', 'Julia'), ('Ruby', 'Julia'), ('Java', 'TypeScript'), ('Kotlin', 'Swift'), ('Python', 'Swift'), ('Ruby', 'Swift'), ('Scala', 'Swift'), ('C', 'Java'), ('C', 'Lua'), ('C', 'Ruby'), ('Python', 'Go'), ('C++', 'Go'), ('Java', 'Go'), ('C++', 'Scala'), ('C', 'Swift'), ('C++', 'Swift'), ('JavaScript', 'Swift'), ('C', 'JavaScript'), ('Python', 'JavaScript'), ('Python', 'Scala'), ('C++', 'Kotlin'), ('Erlang', 'Go'), ('Java', 'C++'), ('Scala', 'Elixir'), ('Python', 'Elixir'), ('Ruby', 'Python'), ('Ruby', 'Kotlin'), ('Swift', 'Kotlin'), ('Go', 'Swift'), ('Go', 'Dart'), ('C++', 'Dart'), ('C++', 'Java'), ('Java', 'Swift'), ('Erlang', 'Julia')]))
rows = list(csv.DictReader(open("/app/languages.csv", encoding="utf-8")))
names = [r["language"].strip() for r in rows]
check(sorted(names) == sorted(LANGUAGES), f"one row per language, named as given ({names})")
years = [int(r["year"]) for r in rows]
check(list(zip(years, names)) == sorted(zip(years, names)), "rows sorted by year, then name")
right_years = sum(int(r["year"]) == LANGUAGES[r["language"].strip()][0] for r in rows)
check(right_years >= 16, f"the first-appearance years ({right_years} of 18 right, 16 needed)")
right_people = sum(any(k.lower() in r["creators"].lower() for k in LANGUAGES[r["language"].strip()][1]) for r in rows)
check(right_people >= 16, f"the creators ({right_people} of 18 right, 16 needed)")
dot = pathlib.Path("/app/influences.dot").read_text(encoding="utf-8")
check(re.search(r"digraph", dot) is not None, "influences.dot is a digraph")
edges = set(re.findall(r'"([^"]+)"\s*->\s*"([^"]+)"', dot))
check(len(edges) >= 15, f"at least 15 edges ({len(edges)})")
check(all(a in LANGUAGES and b in LANGUAGES for a, b in edges), "edges only between the listed languages, named as given")
recall = sum(e in edges for e in CORE)
check(recall >= 8, f"the best-known influences ({recall} of {len(CORE)}, 8 needed)")
precision = sum(e in KNOWN for e in edges) / len(edges)
check(precision >= 0.7, f"documented influences ({precision:.0%} of the edges, 70% needed)")
report = pathlib.Path("/app/report.md").read_text(encoding="utf-8")
check(len(report.split()) >= 1500, f"at least 1500 words ({len(report.split())})")
def language_of(heading):
    # "C (1972)", "1. Python", "Go: ..." or "Swift - ..." name the language before the extras.
    name = re.sub(r"^\d+[.)]\s*", "", heading.strip().strip("*_`"))
    return re.split(r"\s+[(\[:|\u2013\u2014-]|:", name)[0].strip().strip("*_`")
parts = re.split(r"(?m)^##+\s+", report)[1:]
sections = {language_of(p.splitlines()[0]): p for p in parts}
missing = sorted(set(LANGUAGES) - set(sections))
check(not missing, f"a section per language (missing {missing}; headings {sorted(sections)[:30]})")
check(all(re.search(r"https?://", sections[n]) for n in LANGUAGES), "a source URL in each language's section")
domains = {re.sub(r"^www\.", "", d.lower()) for d in re.findall(r"https?://([^/\s)\]>]+)", report)}
check(len(domains) >= 5, f"sources from at least five websites ({sorted(domains)})")
