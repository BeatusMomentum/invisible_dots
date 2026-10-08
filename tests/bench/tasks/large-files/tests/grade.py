"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

check(os.path.exists("/app/large.txt"), "large.txt exists")
got = [" ".join(l.split()) for l in lines("/app/large.txt")]
check(got == ['4819032 music/file_05.mp3', '4679786 docs/file_28.mp3', '4672002 docs/old/file_02.pdf', '4384385 tmp/file_10.bin', '4376251 docs/file_38.pdf', '4264544 docs/file_12.bin', '4136355 music/file_24.pdf', '4132850 tmp/file_16.pdf', '4073606 music/file_20.mp3', '3974554 photos/2025/file_23.jpg', '3901446 music/file_01.bin', '3261945 tmp/file_18.bin', '3207933 music/file_26.mp3', '3169397 photos/2025/file_39.bin', '2990032 docs/old/file_15.bin', '2708221 tmp/file_09.pdf', '2481818 tmp/file_07.bin', '2373902 music/file_21.pdf', '2326557 photos/2025/file_06.mp3', '2038930 tmp/file_19.bin', '1945992 photos/2025/file_27.bin', '1528974 tmp/file_31.pdf', '1140847 photos/2025/file_14.jpg', '1123937 tmp/file_33.pdf'], "every large file, with its size, largest first")
check(len(list(pathlib.Path("/app/data").rglob("*.*"))) == 40, "no file was deleted")
