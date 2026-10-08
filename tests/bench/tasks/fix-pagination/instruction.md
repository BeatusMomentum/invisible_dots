`/app/paginate.py` has a function `paginate(items, page, per_page)` that should return the items of page `page` (pages start at 1) and the total number of pages. Users report that the last page is sometimes missing and that page 1 skips the first item.

Fix the function. Keep its name and signature: other code imports it. A page past the end gives an empty list; an empty list of items has 0 pages; `page` < 1 or `per_page` < 1 raises `ValueError`.
