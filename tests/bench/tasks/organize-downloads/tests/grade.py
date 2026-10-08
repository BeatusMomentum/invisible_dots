"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

root = pathlib.Path("/app/Downloads")
got = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
check(got == ['archives/backup_05.zip', 'archives/invoice_01.zip', 'archives/invoice_12.zip', 'archives/invoice_17.zip', 'archives/notes_21.zip', 'audio/backup_03.mp3', 'audio/backup_20.mp3', 'audio/invoice_06.mp3', 'audio/invoice_13.mp3', 'audio/notes_00.mp3', 'audio/song_10.mp3', 'documents/backup_11.docx', 'documents/backup_16.txt', 'documents/invoice_02.txt', 'documents/notes_14.txt', 'documents/photo_22.docx', 'documents/song_07.txt', 'documents/song_08.docx', 'documents/song_09.pdf', 'documents/song_19.pdf', 'documents/song_23.txt', 'images/invoice_18.png', 'images/notes_15.png', 'images/photo_04.png', 'other/README'], "every file in the folder of its type, names kept")
