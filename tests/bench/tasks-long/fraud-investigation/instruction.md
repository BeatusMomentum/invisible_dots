`/app/transactions.csv` holds a month of card transactions (`tx_id,timestamp,card_id,account_id,merchant_id,amount,currency,country,type`, `type` being `purchase` or `refund`, times in UTC). Investigate it for four kinds of fraud, which count only purchases unless said otherwise:

1. card testing: a card with at least 10 purchases of less than 2.00, all within 10 minutes (the last at most 600 seconds after the first);
2. impossible travel: an account with two purchases in different countries less than 60 minutes apart;
3. duplicate charges: a purchase made with the same card, at the same merchant, for the same amount as an earlier purchase at most 120 seconds before it (report the later one);
4. refund abuse: a merchant with at least 50 transactions (purchases and refunds) of which more than 30% are refunds.

Write:
- `/app/findings.json`: `{"card_testing": [card ids], "impossible_travel": [account ids], "duplicate_charges": [tx ids], "refund_merchants": [merchant ids]}`, each list sorted;
- `/app/analyze.py`, which rebuilds `findings.json` from `transactions.csv` when run from `/app` with `python3 analyze.py`;
- `/app/report.md`, a report for the fraud team: how many cases of each kind, the largest ones, how you found them, and what they should look at first.
