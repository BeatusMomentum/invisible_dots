"""The browser identity rules: one behavior with the host's TypeScript, held by one fixture.

`packages/shared/test/fixtures/identity-rules.json` is read by this file and by
`packages/shared/test/identity-rules.test.ts`. A case that passes there and fails here (or the
other way round) is a rule that differs between the host and the engine.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from nanobot.dots.identity_rules import (
    IDENTITY_ID_MAX,
    IDENTITY_NAME_MAX,
    IdentityRequest,
    IdentityRequestError,
    check_identity_request,
    is_valid_identity_id,
    new_identity_id,
    slugify,
)

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "shared" / "test" / "fixtures" / "identity-rules.json"
CASES: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_fixture_states_the_limits_the_code_has() -> None:
    assert CASES["name_max"] == IDENTITY_NAME_MAX
    assert CASES["id_max"] == IDENTITY_ID_MAX


def test_the_fixture_holds_cases_for_every_rule() -> None:
    checks = CASES["check_request"]
    assert len(checks) > 30
    assert {case["error"]["code"] for case in checks if "error" in case} == {"invalid", "limit"}


@pytest.mark.parametrize("case", CASES["check_request"], ids=lambda case: case["case"])
def test_check_identity_request(case: dict[str, Any]) -> None:
    existing, maximum = case.get("existing", 0), case.get("max", 20)
    if "ok" in case:
        expected = IdentityRequest(case["ok"]["name"], case["ok"].get("proxy"))
        assert check_identity_request(case["input"], existing, maximum) == expected
        return
    with pytest.raises(IdentityRequestError) as caught:
        check_identity_request(case["input"], existing, maximum)
    assert {"code": caught.value.code, "message": caught.value.message} == case["error"]
    assert str(caught.value) == case["error"]["message"]


@pytest.mark.parametrize("case", CASES["slugify"], ids=lambda case: case["case"])
def test_slugify(case: dict[str, str]) -> None:
    if "fallback" in case:
        assert slugify(case["input"], case["fallback"]) == case["expect"]
    else:
        assert slugify(case["input"]) == case["expect"]


@pytest.mark.parametrize("identity_id", CASES["identity_id"]["valid"], ids=repr)
def test_a_valid_identity_id_is_accepted(identity_id: str) -> None:
    assert is_valid_identity_id(identity_id)


@pytest.mark.parametrize("identity_id", CASES["identity_id"]["invalid"], ids=repr)
def test_an_unsafe_identity_id_is_refused(identity_id: str) -> None:
    assert not is_valid_identity_id(identity_id)


@pytest.mark.parametrize("case", CASES["identity_id"]["new"], ids=lambda case: case["case"])
def test_a_new_identity_id_is_the_slug_and_six_random_characters(case: dict[str, str]) -> None:
    identity_id = new_identity_id(case["name"])
    assert re.fullmatch(case["pattern"], identity_id)
    assert is_valid_identity_id(identity_id)


def test_two_new_identity_ids_for_one_name_differ() -> None:
    assert new_identity_id("Work Profile") != new_identity_id("Work Profile")
