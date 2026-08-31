import base64
import hashlib
import secrets

# Encoded into the hash string, so these can be raised later without
# invalidating passwords already stored under the old cost.
_N = 16_384
_R = 8
_P = 1
_KEY_LENGTH = 64
_MAXMEM = 64 * 1024 * 1024


def hash_password(password: str) -> str:
    """scrypt from hashlib — memory-hard, in the standard library, so there is no
    native extension to build in the image.

    The format matches the Node implementation this was ported from, so hashes
    written by either are readable by both.
    """
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_KEY_LENGTH, maxmem=_MAXMEM
    )
    return "$".join(
        [
            "scrypt",
            str(_N),
            str(_R),
            str(_P),
            base64.b64encode(salt).decode(),
            base64.b64encode(derived).decode(),
        ]
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False

    expected = base64.b64decode(hash_b64)
    derived = hashlib.scrypt(
        password.encode(),
        salt=base64.b64decode(salt_b64),
        n=int(n),
        r=int(r),
        p=int(p),
        dklen=len(expected),
        maxmem=_MAXMEM,
    )
    return secrets.compare_digest(derived, expected)
