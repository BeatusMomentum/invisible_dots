"""The checks of this task; any failed assertion gives the reward 0."""
import json, os, pathlib, re, subprocess, sys

def lines(path):
    return [l.rstrip() for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

def check(condition, what):
    if not condition:
        print("FAIL:", what)
        sys.exit(1)
    print("ok:", what)

import html as h, xml.etree.ElementTree as ET
posts = [('2026-01-10', 'Post number 1: Books', 'post-1'), ('2026-02-11', 'Post number 2: Books', 'post-2'), ('2026-03-12', 'Post number 3: Books', 'post-3'), ('2026-04-13', 'Post number 4: Notes', 'post-4'), ('2026-05-14', 'Post number 5: Books', 'post-5'), ('2026-06-15', 'Post number 6: Travel', 'post-6')]
site = pathlib.Path("/app/site")
for date, title, stem in posts:
    page = (site / f"{stem}.html").read_text()
    m = re.search(r"<title>(.*?)</title>", page, re.S | re.I)
    check(m and h.unescape(m.group(1)).strip() == title, f"{stem}: its title")
    check(re.search(r"<h1[^>]*>", page, re.I) and re.search(r"<(em|i)>text</(em|i)>", page, re.I), f"{stem}: heading and emphasis rendered")
    check(re.search(r'<a [^>]*href="https://example.com"', page, re.I) and re.search(r"<li>\s*one\s*</li>", page, re.I), f"{stem}: link and list rendered")
index = (site / "index.html").read_text()
positions = [index.find(f"{stem}.html") for _, _, stem in sorted(posts, reverse=True)]
check(all(p >= 0 for p in positions) and positions == sorted(positions), "the index links every post, newest first")
feed = ET.parse(site / "feed.xml").getroot()
items = feed.findall("./channel/item")
check(feed.tag == "rss" and len(items) == 6, "an RSS feed with one item per post")
check(all(i.find("title") is not None and i.find("link") is not None and i.find("pubDate") is not None for i in items), "each item has title, link, pubDate")
