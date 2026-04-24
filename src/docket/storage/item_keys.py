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


def item_id_from_storage_key(storage_id: str) -> str:
    """Extract the provider-native item id from a storage key.

    All repos that decode keys operate inside a provider-scoped context, so
    the `provider_key` half of the split is never needed — drop the tuple
    and return just the id."""
    if _ITEM_KEY_SEPARATOR not in storage_id:
        return storage_id
    return storage_id.split(_ITEM_KEY_SEPARATOR, 1)[1]


def item_storage_prefix(provider_key: str) -> str:
    return f"{provider_key}{_ITEM_KEY_SEPARATOR}"


__all__ = [
    "item_id_from_storage_key",
    "item_storage_key",
    "item_storage_prefix",
]
