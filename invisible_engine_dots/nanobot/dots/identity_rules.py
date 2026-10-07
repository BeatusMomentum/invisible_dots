"""The rules a browser identity request must meet (architecture section 6), in one place.

The host's TypeScript (`packages/shared/src/identity-rules.ts`, `ids.ts`) states these rules for its
test guest; this module is the engine's own. They are one behavior in two languages: both run the
cases of `packages/shared/test/fixtures/identity-rules.json` (the TypeScript test and
`tests/dots/test_identity_rules.py`), so a rule, a message or an edge case changes in both or the
fixture fails.

What that asks of Python, because the rules were written against JavaScript's `trim()`, `length` and `$`:

* the name is trimmed of exactly what JavaScript trims (not of what `str.strip` trims), and its length
  is counted in UTF-16 code units;
* an id is matched whole (`fullmatch`), never with a `$` that lets a trailing newline through.

A proxy is not judged here. It is an optional string that invisible-playwright-mcp reads when the identity
launches (its own parsing, its own errors), so a request only says whether there is one: a blank one is none.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

IDENTITY_NAME_MAX = 80
IDENTITY_ID_MAX = 64
SLUG_MAX = 32

# What JavaScript's String.prototype.trim removes: WhiteSpace and LineTerminator.
_JS_WHITESPACE = "".join(
    map(chr, (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))
)

# Crockford base32, lowercase: no i, l, o or u (the host's ids.ts has the same alphabet).
_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

_IDENTITY_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

_COMBINING_MARKS = "[" + chr(0x300) + "-" + chr(0x36F) + "]"


class IdentityRequestError(Exception):
    """A request the rules refuse: `invalid` (bad name or proxy type) or `limit` (max_identities reached)."""

    def __init__(self, code: Literal["invalid", "limit"], message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class IdentityRequest:
    """A create request that met the rules: the trimmed name and the proxy exactly as it was given."""

    name: str
    proxy: str | None = None


def _js_length(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def check_identity_request(
    body: Mapping[str, object], existing_count: int, max_identities: int
) -> IdentityRequest:
    """Check a create request against the rules and the identities that exist.

    A non-empty name of at most IDENTITY_NAME_MAX characters, an optional proxy that is a string, and fewer
    than `max_identities` existing identities, in that order. A proxy is an explicit option of one identity,
    never a requirement: absent, null or blank means none, the normal case, and the browser then uses the egress
    of the Dot's VM. One that is given is kept as it was written: invisible-playwright-mcp reads it when the
    identity launches and says what is wrong with it. Returns the trimmed name.
    """
    raw_name = body.get("name")
    name = raw_name.strip(_JS_WHITESPACE) if isinstance(raw_name, str) else ""
    if not name:
        raise IdentityRequestError("invalid", "an identity needs a non-empty name")
    if _js_length(name) > IDENTITY_NAME_MAX:
        raise IdentityRequestError("invalid", f"an identity name is at most {IDENTITY_NAME_MAX} characters")
    raw_proxy = body.get("proxy")
    if raw_proxy is not None and not isinstance(raw_proxy, str):
        raise IdentityRequestError("invalid", "proxy must be a string")
    proxy = raw_proxy if raw_proxy is not None and raw_proxy.strip(_JS_WHITESPACE) else None
    if existing_count >= max_identities:
        raise IdentityRequestError(
            "limit",
            f"this Dot already has {existing_count} browser identities, the most it may keep "
            f"(max_identities {max_identities}); delete one first",
        )
    return IdentityRequest(name, proxy)


def slugify(name: str, fallback: str = "identity") -> str:
    """A lowercase slug of `[a-z0-9-]` for a human name: accents are dropped, everything else becomes `-`.

    Never empty: a name with nothing usable gives `fallback`.
    """
    stripped = re.sub(_COMBINING_MARKS, "", unicodedata.normalize("NFKD", name)).lower()
    slug = re.sub("[^a-z0-9]+", "-", stripped).strip("-")[:SLUG_MAX].rstrip("-")
    return slug or fallback


def new_identity_id(name: str) -> str:
    """A browser identity id: the slug of its name plus six random characters."""
    suffix = "".join(_ALPHABET[byte & 31] for byte in secrets.token_bytes(6))
    return f"{slugify(name)}-{suffix}"


def is_valid_identity_id(identity_id: str) -> bool:
    """Whether a string is a safe identity id; ids become directory names, so nothing that could leave `browsers/`."""
    return len(identity_id) <= IDENTITY_ID_MAX and _IDENTITY_ID.fullmatch(identity_id) is not None
