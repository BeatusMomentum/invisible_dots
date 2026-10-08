"""Writes transactions.csv for the fraud-investigation task (fixed seed: the same file every time)."""
import datetime
import random

rng = random.Random(4242)
START = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc).timestamp()
DAYS = 30
COUNTRIES = ["IT", "FR", "DE", "ES", "NL", "PT", "AT", "BE"]
accounts = {f"A{i:05d}": rng.choice(COUNTRIES) for i in range(2000)}
cards = {f"C{i:05d}": f"A{i // 2:05d}" for i in range(4000)}
merchants = [f"M{i:04d}" for i in range(300)]
rows = []  # (ts, card, account, merchant, amount, country, type)
used = set()


def add(ts, card, merchant, amount, country=None, kind="purchase"):
    ts = int(ts)
    while (card, ts) in used:
        ts += 1
    used.add((card, ts))
    account = cards[card]
    rows.append((ts, card, account, merchant, round(amount, 2), country or accounts[account], kind))


card_list = list(cards)
special = set()

# Card testing: 15 cards, 10 to 18 purchases under 2.00 within 8 minutes.
testers = rng.sample(card_list, 15)
special.update(testers)
for card in testers:
    t0 = START + rng.uniform(0, DAYS * 86400 - 3600)
    for _ in range(rng.randint(10, 18)):
        add(t0 + rng.uniform(0, 480), card, rng.choice(merchants), rng.uniform(0.5, 1.99))
# Decoys: 9 small purchases in 10 minutes; 12 small purchases over two hours.
for card in rng.sample([c for c in card_list if c not in special], 20):
    special.add(card)
    t0 = START + rng.uniform(0, DAYS * 86400 - 9000)
    spread = 590 if len(special) % 2 else 7200
    for _ in range(9 if spread == 590 else 12):
        add(t0 + rng.uniform(0, spread), card, rng.choice(merchants), rng.uniform(0.5, 1.99))

# Impossible travel: 25 accounts with purchases in two countries 5 to 55 minutes apart; decoys 61 to 90 minutes.
account_list = list(accounts)
for i, account in enumerate(rng.sample(account_list, 45)):
    card = f"C{int(account[1:]) * 2:05d}"
    t0 = START + rng.uniform(0, DAYS * 86400 - 7200)
    gap = rng.uniform(300, 3300) if i < 25 else rng.uniform(3660, 5400)
    abroad = rng.choice([c for c in COUNTRIES if c != accounts[account]])
    add(t0, card, rng.choice(merchants), rng.uniform(10, 200))
    add(t0 + gap, card, rng.choice(merchants), rng.uniform(10, 200), country=abroad)

# Duplicate charges: 40 purchases repeated 30 to 110 seconds later; decoys 130 to 300 seconds.
for i in range(70):
    card = rng.choice(card_list)
    merchant = rng.choice(merchants)
    amount = rng.uniform(5, 300)
    t0 = START + rng.uniform(0, DAYS * 86400 - 600)
    add(t0, card, merchant, amount)
    add(t0 + (rng.uniform(30, 110) if i < 40 else rng.uniform(130, 300)), card, merchant, amount)

# Background purchases.
for _ in range(285_000):
    add(START + rng.uniform(0, DAYS * 86400), rng.choice(card_list), rng.choice(merchants[:280]), rng.lognormvariate(3.3, 0.9) + 2.0)

# Refund rates: merchants 280..299 are small merchants with a chosen refund share.
for j, merchant in enumerate(merchants[280:]):
    n = 30 if j == 19 else rng.randint(60, 120)
    share = [0.35, 0.40, 0.45, 0.50, 0.38, 0.33][j] if j < 6 else (rng.uniform(0.25, 0.29) if j < 12 else (0.6 if j == 19 else rng.uniform(0.0, 0.1)))
    refunds = round(n * share)
    for k in range(n):
        add(START + rng.uniform(0, DAYS * 86400), rng.choice(card_list), merchant, rng.uniform(5, 150), kind="refund" if k < refunds else "purchase")
# Normal refunds elsewhere: 2 percent.
for _ in range(5000):
    add(START + rng.uniform(0, DAYS * 86400), rng.choice(card_list), rng.choice(merchants[:280]), rng.uniform(5, 150), kind="refund")

rows.sort()
with open("transactions.csv", "w", encoding="utf-8", newline="\n") as out:
    out.write("tx_id,timestamp,card_id,account_id,merchant_id,amount,currency,country,type\n")
    for i, (ts, card, account, merchant, amount, country, kind) in enumerate(rows):
        stamp = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.write(f"T{i + 1:07d},{stamp},{card},{account},{merchant},{amount:.2f},EUR,{country},{kind}\n")
