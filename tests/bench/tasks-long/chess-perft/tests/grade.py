"""The checks of this task; any failed check gives the reward 0."""
import json, os, pathlib, re, subprocess, sys, time

def check(condition, what):
    if not condition:
        print("FAIL:", what, flush=True)
        sys.exit(1)
    print("ok:", what, flush=True)

cases = [('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 5, 4865609), ('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 4, 4085603), ('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 5, 674624), ('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 4, 422333), ('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 4, 2103487), ('r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', 3, 89890), ('rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6 0 2', 4, 437149), ('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 4, 17945), ('8/P7/8/8/8/8/7p/K6k w - - 0 1', 5, 15290)]
check(os.access("/app/perft", os.X_OK), "/app/perft is executable")
for fen, depth, count in sorted(cases, key=lambda c: c[2]):
    started = time.time()
    try:
        out = subprocess.run(["/app/perft", fen, str(depth)], capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        check(False, f"{fen} depth {depth} within 15 minutes")
    got = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    check(got == str(count), f"{fen} depth {depth}: {count} (got {got!r} in {time.time() - started:.0f} s)")
