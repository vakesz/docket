from __future__ import annotations

_ITEM_KEY_SEPARATOR = "\x1f"


def item_storage_key(provider_key: str, item_id: str) -> str:
    """Internal cache key for provider-scoped rows.

    Public APIs and domain models continue to speak in provider-native ids;
    SQLite stores a provider-qualified key so overlapping ids from different
    backends never collide."""
    if not provider_key:
        return item_id
    return f"{provider_key}{_ITEM_KEY_SEPARATOR}{item_id}"


def split_item_storage_key(storage_id: str) -> tuple[str, str]:
    if _ITEM_KEY_SEPARATOR not in storage_id:
        return "", storage_id
    provider_key, item_id = storage_id.split(_ITEM_KEY_SEPARATOR, 1)
    return provider_key, item_id


def item_storage_prefix(provider_key: str) -> str:
    return f"{provider_key}{_ITEM_KEY_SEPARATOR}"


__all__ = [
    "item_storage_key",
    "item_storage_prefix",
    "split_item_storage_key",
]
