`/app/temps.csv` has one temperature reading per day of 2025 (`day,celsius`); a missing reading is an empty cell.

Ignoring the missing readings, write to `/app/stats.json` an object with `median` and `stdev` (the population standard deviation), both rounded to 2 decimals, and `hot_days`, the number of days above 25 °C.
