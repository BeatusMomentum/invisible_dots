"""The rules a browser identity request must meet (architecture section 6), in one place.

The host's TypeScript (`packages/shared/src/identity-rules.ts`, `ids.ts`) states these rules for its
test guest; this module is the engine's own. They are one behavior in two languages: both run the
cases of `packages/shared/test/fixtures/identity-rules.json` (the TypeScript test and
`tests/dots/test_identity_rules.py`), so a rule, a message or an edge case changes in both or the
fixture fails.

What that asks of Python, because the rules were written against JavaScript's `URL`, `trim()`,
`length` and `$`:

* the name is trimmed of exactly what JavaScript trims (not of what `str.strip` trims), and its length
  is counted in UTF-16 code units;
* a proxy is parsed the way the WHATWG URL standard parses the part a proxy is made of (scheme,
  user, password, host, port, then the rest kept as written). Hosts that are ASCII or a bracketed
  IPv6 address are pinned by the fixture; a non-ASCII host is converted with IDNA and a bad one is
  refused. Dot segments and percent-encoding of the path are not normalized: the path of a proxy is
  never used, only shown;
* an id is matched whole (`fullmatch`), never with a `$` that lets a trailing newline through.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote, unquote

IDENTITY_NAME_MAX = 80
IDENTITY_ID_MAX = 64
SLUG_MAX = 32

PROXY_SCHEMES = frozenset({"http", "https", "socks4", "socks5"})

# What JavaScript's String.prototype.trim removes: WhiteSpace and LineTerminator.
_JS_WHITESPACE = "".join(
    map(chr, (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))
)

# Crockford base32, lowercase: no i, l, o or u (the host's ids.ts has the same alphabet).
_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

_IDENTITY_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):")
_DIGITS = re.compile(r"[0-9]+")
_FORBIDDEN_HOST = re.compile(r"[\x00-\x20#/:<>?@\[\\\]^|\x7f]")
_FORBIDDEN_SPECIAL_HOST = re.compile(r"[\x00-\x20#%/:<>?@\[\\\]^|\x7f]")

# WHATWG "special" schemes with a default port (file has none and may have an empty host).
_SPECIAL_PORTS = {"ftp": "21", "http": "80", "https": "443", "ws": "80", "wss": "443"}

# The userinfo percent-encode set: every printable ASCII character outside it is written as is.
_USERINFO_SAFE = "".join(c for c in map(chr, range(0x21, 0x7F)) if c not in "\"#<>?`{}/:;=@[\\]^|")

_COMBINING_MARKS = "[" + chr(0x300) + "-" + chr(0x36F) + "]"

_MISSING = object()


class IdentityRequestError(Exception):
    """A request the rules refuse: `invalid` (bad name or proxy) or `limit` (max_identities reached)."""

    def __init__(self, code: Literal["invalid", "limit"], message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class IdentityRequest:
    """A create request that met the rules, with the trimmed values."""

    name: str
    proxy: str | None = None


@dataclass(frozen=True)
class _Url:
    scheme: str
    # None when the URL has no authority (`localhost:8080` is the scheme `localhost` and an opaque path).
    host: str | None
    port: str
    user: str
    password: str
    # The path, query and fragment as written (an opaque URL keeps everything after the scheme here).
    rest: str

    def href(self, password: str | None = None) -> str:
        """The URL as WHATWG serializes it, with the password replaced when one is given."""
        if self.host is None:
            return f"{self.scheme}:{self.rest}"
        secret = self.password if password is None else password
        userinfo = ""
        if self.user or secret:
            userinfo = self.user + (f":{secret}" if secret else "") + "@"
        port = f":{self.port}" if self.port else ""
        return f"{self.scheme}://{userinfo}{self.host}{port}{self.rest}"


def _split_authority(rest: str, special: bool) -> tuple[str, str]:
    ends = "/?#\\" if special else "/?#"
    end = next((i for i, c in enumerate(rest) if c in ends), len(rest))
    return rest[:end], rest[end:]


def _host_and_port(hostport: str, scheme: str, special: bool) -> tuple[str, str] | None:
    if hostport.startswith("["):
        close = hostport.find("]")
        if close < 0:
            return None
        after = hostport[close + 1 :]
        if after and not after.startswith(":"):
            return None
        try:
            host = "[" + ipaddress.IPv6Address(hostport[1:close]).compressed + "]"
        except ValueError:
            return None
        port = after[1:]
    else:
        host, _, port = hostport.partition(":")
        if special:
            host = unquote(host).lower()
            if not host.isascii():
                try:
                    host = host.encode("idna").decode("ascii")
                except UnicodeError:
                    return None
            if _FORBIDDEN_SPECIAL_HOST.search(host):
                return None
        elif _FORBIDDEN_HOST.search(host):
            return None
    if port:
        if not _DIGITS.fullmatch(port) or int(port) > 65535:
            return None
        port = str(int(port))
        if port == _SPECIAL_PORTS.get(scheme):
            port = ""
    return host, port


def _parse_url(text: str) -> _Url | None:
    """Parse `text` the way `new URL(text)` does for what a proxy is made of; None where it throws."""
    text = text.strip("".join(map(chr, range(0x21)))).replace("\t", "").replace("\n", "").replace("\r", "")
    match = _SCHEME.match(text)
    if match is None:
        return None
    scheme = match.group(1).lower()
    rest = text[match.end() :]
    special = scheme in _SPECIAL_PORTS
    if special:
        rest = rest.lstrip("/\\")
    elif rest.startswith("//"):
        rest = rest[2:]
    else:
        return _Url(scheme, None, "", "", "", rest)
    authority, tail = _split_authority(rest, special)
    userinfo, at, hostport = authority.rpartition("@")
    if special and not hostport:
        return None
    parsed = _host_and_port(hostport, scheme, special)
    if parsed is None:
        return None
    host, port = parsed
    user, _, password = userinfo.partition(":") if at else ("", "", "")
    if special:
        end = next((i for i, c in enumerate(tail) if c in "?#"), len(tail))
        tail = tail[:end].replace("\\", "/") + tail[end:]
        if not tail.startswith("/"):
            tail = "/" + tail
    return _Url(
        scheme, host, port, quote(user, safe=_USERINFO_SAFE + "%"), quote(password, safe=_USERINFO_SAFE + "%"), tail
    )


def redact_proxy(proxy: str) -> str:
    """`http://user:secret@host` with the password replaced, for logs and for anything shown to a model or a person."""
    url = _parse_url(proxy)
    if url is None:
        return "<unparseable proxy>"
    href = url.href("***" if url.password else None)
    return href[:-1] if href.endswith("/") else href


def _js_length(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def check_identity_request(
    body: Mapping[str, object], existing_count: int, max_identities: int
) -> IdentityRequest:
    """Check a create request against the rules and the identities that exist.

    A non-empty name of at most IDENTITY_NAME_MAX characters, an optional proxy URL with an http,
    https, socks4 or socks5 scheme and a host, and fewer than `max_identities` existing identities,
    in that order. A proxy that is absent or blank means none. Returns the trimmed values.
    """
    raw_name = body.get("name")
    name = raw_name.strip(_JS_WHITESPACE) if isinstance(raw_name, str) else ""
    if not name:
        raise IdentityRequestError("invalid", "an identity needs a non-empty name")
    if _js_length(name) > IDENTITY_NAME_MAX:
        raise IdentityRequestError("invalid", f"an identity name is at most {IDENTITY_NAME_MAX} characters")
    raw_proxy = body.get("proxy", _MISSING)
    if raw_proxy is not _MISSING and not isinstance(raw_proxy, str):
        raise IdentityRequestError("invalid", "proxy must be a string")
    proxy = raw_proxy.strip(_JS_WHITESPACE) if isinstance(raw_proxy, str) else ""
    if proxy:
        url = _parse_url(proxy)
        if url is None:
            raise IdentityRequestError(
                "invalid", "proxy must be a URL such as http://user:pass@host:port or socks5://host:port"
            )
        if url.scheme not in PROXY_SCHEMES or not url.host:
            raise IdentityRequestError(
                "invalid",
                "proxy must use http, https, socks4 or socks5 and name a host; "
                f'got "{redact_proxy(proxy)}"',
            )
    if existing_count >= max_identities:
        raise IdentityRequestError(
            "limit",
            f"this Dot already has {existing_count} browser identities, the most its configuration "
            f"allows (max_identities {max_identities}); delete one first",
        )
    return IdentityRequest(name, proxy or None)


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
