`/app/posts` holds blog posts in Markdown, each with a front matter (`title`, `date`). Build the site into `/app/site`:

- one HTML page per post, `site/<file name without .md>.html`, with the post's title in `<title>`, the Markdown rendered to HTML (headings, emphasis, links and lists at least);
- `site/index.html` listing every post as a link to its page with its title, newest first;
- `site/feed.xml`, an RSS 2.0 feed with one `<item>` per post (`title`, `link` to the page, `pubDate`).

Use only what is on this computer (you may install Ubuntu packages with `sudo dot-install`).
