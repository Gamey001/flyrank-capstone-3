import ipaddress


def is_private_ip(ip: str | None) -> bool:
    """Note an unparseable address answers True: callers use this to decide
    whether a geo lookup is worth attempting, and garbage never is."""
    if not ip:
        return True
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        parsed = parsed.ipv4_mapped
    return bool(
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_unspecified
        or parsed.is_reserved
        or parsed.is_multicast
    )


def is_valid_ip(ip: str) -> bool:
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return False
    return True
