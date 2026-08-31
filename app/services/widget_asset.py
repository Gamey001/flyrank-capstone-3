import hashlib
from pathlib import Path

_WIDGET_PATH = Path(__file__).parent.parent / "widget" / "widget.js"

SOURCE = _WIDGET_PATH.read_text()

# Hashing the bundle's own bytes is what makes its URL safe to cache forever:
# changed content necessarily lands at a different URL.
_HASH = hashlib.sha256(SOURCE.encode()).hexdigest()[:12]

VERSION = f"v{_HASH}"
ETAG = f'"{_HASH}"'
BYTE_LENGTH = len(SOURCE.encode())
VERSIONED_PATH = f"/embed/{VERSION}/widget.js"
