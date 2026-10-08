#!/bin/bash
# Prints, for a CSV of date,category,amount (with a header), the number of rows, the total amount, and the total per category sorted by name.
file=$1
rows=$(tail -n +2 "$file" | grep -c .)
echo "rows: $rows"
tail -n +2 "$file" | awk -F, '{t += $3} END {printf "total: %.2f\n", t}'
tail -n +2 "$file" | awk -F, '{s[$2] += $3} END {for (c in s) printf "%s: %.2f\n", c, s[c]}' | sort
