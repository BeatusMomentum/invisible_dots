def paginate(items, page, per_page):
    """Return (the items of page `page`, starting at 1, the number of pages)."""
    pages = len(items) // per_page
    start = page * per_page
    return items[start + 1:start + per_page], pages
