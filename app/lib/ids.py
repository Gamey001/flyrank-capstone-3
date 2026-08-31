import secrets
import uuid

# No l/1/0/o — the id is read aloud and pasted by hand.
_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"


def public_widget_id(length: int = 16) -> str:
    """Unguessable rather than sequential: this id is public, so an enumerable
    one would expose every tenant's widget config."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def new_uuid() -> str:
    return str(uuid.uuid4())
