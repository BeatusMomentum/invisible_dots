"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

data = json.loads(pathlib.Path("/app/people.json").read_text())
check(data == [{'id': 1, 'name': 'Ada', 'age': 55, 'city': 'Roma', 'member': False}, {'id': 2, 'name': 'Bruno', 'age': 53, 'city': 'Milano', 'member': False}, {'id': 3, 'name': 'Chiara', 'age': 53, 'city': 'Roma', 'member': False}, {'id': 4, 'name': 'Dmitri', 'age': 75, 'city': 'Torino', 'member': True}, {'id': 5, 'name': 'Elena', 'age': 45, 'city': 'Roma', 'member': False}, {'id': 6, 'name': 'Farah', 'age': 46, 'city': 'Napoli', 'member': True}, {'id': 7, 'name': 'Giulio', 'age': 60, 'city': 'Torino', 'member': False}, {'id': 8, 'name': 'Hana', 'age': 66, 'city': 'Torino', 'member': True}, {'id': 9, 'name': 'Ivo', 'age': 37, 'city': 'Milano', 'member': True}, {'id': 10, 'name': 'Jun', 'age': 46, 'city': 'Torino', 'member': True}, {'id': 11, 'name': 'Kofi', 'age': 40, 'city': 'Torino', 'member': True}, {'id': 12, 'name': 'Lea', 'age': 22, 'city': 'Torino', 'member': True}], "every row, typed, in order")
