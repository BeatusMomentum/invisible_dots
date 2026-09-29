<div align="center">

# dots

**Open-source dots for the web: an agent with its own browser, one that does not get blocked. Tell it what you want in plain language.**

</div>

---

Windows, in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
uvx --from git+https://github.com/feder-cr/dots dots --openrouter-key sk-or-...
```

Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env
uvx --from git+https://github.com/feder-cr/dots dots --openrouter-key sk-or-...
```

Then open **http://127.0.0.1:8765**. Chat on the left, the live browser on the right.

## What to ask it

> Go to `<paste the URL>`. One way, Milan to Lisbon, economy, one adult. Check
> every date from the 12th to the 16th of next month and read the cheapest fare
> for each day. If a date has no availability, say so. Do not guess a number.

It drives the page the way a person would: the pointer moves, keys are pressed.

## From your own assistant

Claude Code, Codex, Gemini CLI or any MCP client: use
[invisible_playwright_mcp](https://github.com/feder-cr/invisible_playwright_mcp),
the same browser as a server. `dots` is its interface, and every option it takes
is listed by `dots --help`.

---

Not affiliated with OpenAI. MIT licensed.
