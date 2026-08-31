from typing import Annotated

from email_validator import EmailNotValidError, validate_email
from pydantic import AfterValidator


def _validate_email(value: str) -> str:
    """One definition of a valid email for the whole app.

    Syntax only. Deliverability is deliberately not checked: this system stores
    leads typed by strangers, and a DNS lookup per submission would put a third
    party on the request path — the exact dependency the enrichment chain is
    built to survive.

    `test_environment` allows the RFC 2606 reserved TLDs (.test, .example,
    .invalid, .localhost). They are syntactically valid, the demo data and every
    example in the brief use them, and rejecting them while accepting any other
    unresolvable domain would be inconsistent.
    """
    try:
        result = validate_email(value, check_deliverability=False, test_environment=True)
    except EmailNotValidError as exc:
        raise ValueError(str(exc)) from exc
    return str(result.normalized)


Email = Annotated[str, AfterValidator(_validate_email)]
