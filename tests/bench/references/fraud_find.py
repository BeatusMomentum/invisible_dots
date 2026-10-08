"""The reference analysis of the fraud-investigation task: findings.json from transactions.csv."""
import bisect
import collections
import csv
import datetime
import json


def seconds(stamp):
    return int(datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())


small = collections.defaultdict(list)
by_account = collections.defaultdict(list)
by_key = collections.defaultdict(list)
merchant_all = collections.Counter()
merchant_refunds = collections.Counter()
for r in csv.DictReader(open("transactions.csv", encoding="utf-8")):
    merchant_all[r["merchant_id"]] += 1
    if r["type"] == "refund":
        merchant_refunds[r["merchant_id"]] += 1
        continue
    ts = seconds(r["timestamp"])
    amount = float(r["amount"])
    if amount < 2.00:
        small[r["card_id"]].append(ts)
    by_account[r["account_id"]].append((ts, r["country"]))
    by_key[(r["card_id"], r["merchant_id"], r["amount"])].append((ts, r["tx_id"]))

card_testing = []
for card, times in small.items():
    times.sort()
    if any(bisect.bisect_right(times, t + 600) - i >= 10 for i, t in enumerate(times)):
        card_testing.append(card)

impossible = []
for account, purchases in by_account.items():
    purchases.sort()
    flagged = False
    for i, (t, country) in enumerate(purchases):
        j = i + 1
        while j < len(purchases) and purchases[j][0] - t < 3600:
            if purchases[j][1] != country:
                flagged = True
                break
            j += 1
        if flagged:
            break
    if flagged:
        impossible.append(account)

duplicates = []
for items in by_key.values():
    items.sort()
    for (t1, _), (t2, tx2) in zip(items, items[1:]):
        if t2 - t1 <= 120:
            duplicates.append(tx2)

refund_merchants = [m for m, n in merchant_all.items() if n >= 50 and merchant_refunds[m] / n > 0.30]

json.dump(
    {
        "card_testing": sorted(card_testing),
        "impossible_travel": sorted(impossible),
        "duplicate_charges": sorted(duplicates),
        "refund_merchants": sorted(refund_merchants),
    },
    open("findings.json", "w"),
    indent=1,
)
