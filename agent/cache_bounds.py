"""Bounds for long-lived in-process caches that would otherwise grow for the life of a gateway.

Each helper sheds only what no reader can use (expired entries) or what nobody has touched in the
longest time (least recently used, past a count far above any real working set). Callers hold
their own lock where the cache is shared across threads; snapshots are taken before iterating.
"""

from typing import Any, Callable


def drop_expired(values: dict, stamps: dict, ttl: float, now: float) -> None:
    """Pop every ``values`` key whose stamp (missing = 0, like the readers) is ``ttl`` old."""
    for key in [k for k in list(values) if now - stamps.get(k, 0) >= ttl]:
        values.pop(key, None)
        stamps.pop(key, None)


def evict_oldest(cache: dict, key: Any, stamp_of: Callable[[Any], float], limit: int, *siblings: dict) -> None:
    """Make room for a NEW ``key``: past ``limit``, drop the oldest-stamped key from ``cache`` and every sibling."""
    if key in cache or len(cache) < limit:
        return
    oldest = min(list(cache.items()), key=lambda item: stamp_of(item[1]))[0]
    for table in (cache, *siblings):
        table.pop(oldest, None)


def publish_lru(table: dict, key: Any, value: Any, limit: int, *siblings: dict) -> list:
    """Store ``key`` as most recently used; past ``limit``, drop the least recently used keys from
    ``table`` and every sibling. Returns the evicted keys (for companions that are not dicts)."""
    table.pop(key, None)
    table[key] = value
    evicted = []
    while len(table) > limit:
        stale = next(iter(table))
        evicted.append(stale)
        for scoped in (table, *siblings):
            scoped.pop(stale, None)
    return evicted
