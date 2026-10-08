#!/usr/bin/env python3
"""perft FEN DEPTH: the number of legal move sequences of DEPTH plies from the position FEN."""
import sys

N, S, E, W = -10, 10, 1, -1
KNIGHT = (-21, -19, -12, -8, 8, 12, 19, 21)
KING = (N, S, E, W, N + E, N + W, S + E, S + W)
BISHOP = (N + E, N + W, S + E, S + W)
ROOK = (N, S, E, W)
# A 10x12 mailbox: index 21 is a8, 98 is h1; off-board squares are " ".


def parse(fen):
    placement, side, castling, ep = fen.split()[:4]
    board = [" "] * 120
    rows = placement.split("/")
    for r, row in enumerate(rows):
        f = 0
        for ch in row:
            if ch.isdigit():
                for _ in range(int(ch)):
                    board[21 + r * 10 + f] = "."
                    f += 1
            else:
                board[21 + r * 10 + f] = ch
                f += 1
    rights = set(castling) - {"-"}
    eps = None if ep == "-" else 21 + (8 - int(ep[1])) * 10 + "abcdefgh".index(ep[0])
    return board, side, rights, eps


def own(p, side):
    return p.isupper() if side == "w" else p.islower()


def enemy(p, side):
    return p.isalpha() and not own(p, side)


def attacked(board, sq, by):
    """Whether side `by` attacks square sq."""
    up = by == "w"
    pawn = "P" if up else "p"
    for d in ((S + E, S + W) if up else (N + E, N + W)):
        if board[sq + d] == pawn:
            return True
    knight, king = ("N", "K") if up else ("n", "k")
    rq, bq = (("R", "Q"), ("B", "Q")) if up else (("r", "q"), ("b", "q"))
    for d in KNIGHT:
        if board[sq + d] == knight:
            return True
    for d in KING:
        if board[sq + d] == king:
            return True
    for dirs, pieces in ((ROOK, rq), (BISHOP, bq)):
        for d in dirs:
            t = sq + d
            while board[t] == ".":
                t += d
            if board[t] in pieces:
                return True
    return False


def moves(state):
    board, side, rights, ep = state
    out = []
    forward = N if side == "w" else S
    start_row = (81, 88) if side == "w" else (31, 38)
    promo_row = (21, 28) if side == "w" else (91, 98)
    for sq in range(21, 99):
        p = board[sq]
        if not p.isalpha() or not own(p, side):
            continue
        kind = p.upper()
        if kind == "P":
            t = sq + forward
            if board[t] == ".":
                out.append((sq, t))
                if start_row[0] <= sq <= start_row[1] and board[t + forward] == ".":
                    out.append((sq, t + forward))
            for d in (forward + E, forward + W):
                t = sq + d
                if enemy(board[t], side) or t == ep:
                    out.append((sq, t))
            continue
        dirs = {"N": KNIGHT, "K": KING, "B": BISHOP, "R": ROOK, "Q": ROOK + BISHOP}[kind]
        slide = kind in "BRQ"
        for d in dirs:
            t = sq + d
            while True:
                q = board[t]
                if q == " " or (q.isalpha() and own(q, side)):
                    break
                out.append((sq, t))
                if q != "." or not slide:
                    break
                t += d
    expanded = []
    for frm, to in out:
        if board[frm].upper() == "P" and promo_row[0] <= to <= promo_row[1]:
            for promo in "QRBN":
                expanded.append((frm, to, promo))
        else:
            expanded.append((frm, to, None))
    # Castling.
    opp = "b" if side == "w" else "w"
    if side == "w":
        if "K" in rights and board[96] == board[97] == "." and board[95] == "K" and board[98] == "R" and not any(attacked(board, s, opp) for s in (95, 96, 97)):
            expanded.append((95, 97, "castle"))
        if "Q" in rights and board[94] == board[93] == board[92] == "." and board[95] == "K" and board[91] == "R" and not any(attacked(board, s, opp) for s in (95, 94, 93)):
            expanded.append((95, 93, "castle"))
    else:
        if "k" in rights and board[26] == board[27] == "." and board[25] == "k" and board[28] == "r" and not any(attacked(board, s, opp) for s in (25, 26, 27)):
            expanded.append((25, 27, "castle"))
        if "q" in rights and board[24] == board[23] == board[22] == "." and board[25] == "k" and board[21] == "r" and not any(attacked(board, s, opp) for s in (25, 24, 23)):
            expanded.append((25, 23, "castle"))
    return expanded


def play(state, move):
    board, side, rights, ep = state
    frm, to, extra = move
    b = board[:]
    p = b[frm]
    new_ep = None
    if extra == "castle":
        b[to], b[frm] = p, "."
        rook_from, rook_to = {97: (98, 96), 93: (91, 94), 27: (28, 26), 23: (21, 24)}[to]
        b[rook_to], b[rook_from] = b[rook_from], "."
    else:
        if p.upper() == "P" and to == ep:
            b[to + (S if side == "w" else N)] = "."
        if p.upper() == "P" and abs(to - frm) == 20:
            new_ep = (to + frm) // 2
        b[to], b[frm] = p, "."
        if extra:
            b[to] = extra if side == "w" else extra.lower()
    r = set(rights)
    for sq, lost in ((95, "KQ"), (25, "kq"), (98, "K"), (91, "Q"), (28, "k"), (21, "q")):
        if frm == sq or to == sq:
            r -= set(lost)
    return b, ("b" if side == "w" else "w"), r, new_ep


def legal(state):
    _, side, _, _ = state
    king = "K" if side == "w" else "k"
    opp = "b" if side == "w" else "w"
    for m in moves(state):
        nxt = play(state, m)
        if not attacked(nxt[0], nxt[0].index(king), opp):
            yield nxt


def perft(state, depth):
    if depth == 0:
        return 1
    if depth == 1:
        return sum(1 for _ in legal(state))
    return sum(perft(n, depth - 1) for n in legal(state))


if __name__ == "__main__":
    print(perft(parse(sys.argv[1]), int(sys.argv[2])))
