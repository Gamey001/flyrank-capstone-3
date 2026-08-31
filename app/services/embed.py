from typing import Any

from app.config.settings import settings
from app.services import widget_asset


# Generated on read rather than stored, so an existing widget starts serving a
# new bundle version the moment one is released.
def for_widget(public_id: str) -> dict[str, Any]:
    base = settings.PUBLIC_BASE_URL.rstrip("/")
    script_url = f"{base}{widget_asset.VERSIONED_PATH}?id={public_id}"
    return {
        "version": widget_asset.VERSION,
        "scriptUrl": script_url,
        "configUrl": f"{base}/api/public/widgets/{public_id}/config",
        "snippet": f'<script src="{script_url}" async></script>',
        "snippetWithPlaceholder": (
            f'<div data-flyrank-widget="{public_id}"></div>\n'
            f'<script src="{script_url}" async></script>'
        ),
    }
