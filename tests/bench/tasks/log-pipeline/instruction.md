`/app/logs` holds a week of an application's logs: `app.log` (today) and the rotated `app.log.1.gz` ... `app.log.6.gz`. Each line is `<ISO time> <LEVEL> <component> <message> ms=<duration>`.

Write `/app/daily.csv` with the header `day,lines,errors,p95_ms` and one row per day (from the timestamps, oldest first): the number of lines, the number of `ERROR` lines and the 95th percentile of `ms` (inclusive method: the value at rank 0.95 × (n − 1), interpolated linearly between the two nearest values), rounded to 1 decimal.

Also write `/app/daily.sh`, a script that rebuilds `daily.csv` from the logs when run from `/app`.
