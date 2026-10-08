#!/bin/bash
set -euo pipefail
cd /app
python3 - <<'EOF'
import pathlib, re, html, datetime
src = pathlib.Path("posts"); out = pathlib.Path("site"); out.mkdir(exist_ok=True)
def md(t):
    o = []; inlist = False
    for line in t.splitlines():
        line = html.escape(line)
        line = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', line)
        line = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", line)
        if line.startswith("- "):
            if not inlist: o.append("<ul>"); inlist = True
            o.append(f"<li>{line[2:]}</li>"); continue
        if inlist: o.append("</ul>"); inlist = False
        if line.startswith("# "): o.append(f"<h1>{line[2:]}</h1>")
        elif line.strip(): o.append(f"<p>{line}</p>")
    if inlist: o.append("</ul>")
    return "\n".join(o)
posts = []
for f in src.glob("*.md"):
    _, fm, body = f.read_text().split("---", 2)
    meta = dict(l.split(": ", 1) for l in fm.strip().splitlines())
    posts.append((meta["date"], meta["title"], f.stem))
    (out / f"{f.stem}.html").write_text(f"<html><head><title>{html.escape(meta['title'])}</title></head><body>{md(body)}</body></html>")
posts.sort(reverse=True)
(out / "index.html").write_text("<html><head><title>Blog</title></head><body><ul>" + "".join(f'<li><a href="{s}.html">{html.escape(t)}</a></li>' for d, t, s in posts) + "</ul></body></html>")
items = "".join(f"<item><title>{html.escape(t)}</title><link>{s}.html</link><pubDate>{datetime.date.fromisoformat(d).strftime('%a, %d %b %Y')} 00:00:00 +0000</pubDate></item>" for d, t, s in posts)
(out / "feed.xml").write_text(f'<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>index.html</link><description>Blog</description>{items}</channel></rss>')
EOF
