"""Catalog caches in a long-lived process: one models.dev parse, no dead pricing catalogs."""

from __future__ import annotations

from agent import models_dev
import hermes_cli.models_catalog_static as static
import hermes_cli.models_pricing as pricing


def test_xai_floor_reuses_the_process_models_dev_copy_without_network(monkeypatch):
    catalog = {"xai": {"id": "xai", "models": {"grok-z": {}, "grok-a": {}}}}
    parses = []
    monkeypatch.setattr(models_dev, "_models_dev_cache", {})
    monkeypatch.setattr(models_dev, "_models_dev_cache_time", 0)
    monkeypatch.setattr(models_dev, "_load_disk_cache", lambda: parses.append(1) or catalog)
    monkeypatch.setattr(models_dev, "_disk_cache_age_seconds", lambda: 10.0)
    monkeypatch.setattr(models_dev, "_refresh_locked", lambda *a, **k: (_ for _ in ()).throw(AssertionError("network")))

    ids = static._xai_curated_models()

    assert "grok-a" in ids and "grok-z" in ids
    assert models_dev.fetch_models_dev(allow_network=False) is catalog
    assert models_dev.fetch_models_dev() is catalog  # fresh copy: served from memory, no request
    assert len(parses) == 1


def test_pricing_cache_write_drops_catalogs_past_their_deadline(monkeypatch):
    now = {"t": 100.0}
    monkeypatch.setattr(pricing.time, "monotonic", lambda: now["t"])
    monkeypatch.setattr(pricing, "_pricing_cache", {})
    monkeypatch.setattr(pricing, "_pricing_cache_retry_after", {})
    pricing._cache_catalog("https://n.example\x00auth:old", {"m": {"prompt": "1"}}, ttl_seconds=300)
    pricing._cache_catalog("https://static.example", {"m": {"prompt": "1"}})
    now["t"] = 500.0
    pricing._cache_catalog("https://n.example\x00auth:live", {"m": {"prompt": "2"}}, ttl_seconds=300)

    pricing._cache_catalog("https://n.example\x00auth:new", {"m": {"prompt": "3"}}, ttl_seconds=300)

    assert set(pricing._pricing_cache) == {"https://static.example", "https://n.example\x00auth:live", "https://n.example\x00auth:new"}
    assert "https://n.example\x00auth:old" not in pricing._pricing_cache_retry_after
    assert pricing._cached_catalog("https://n.example\x00auth:live") == {"m": {"prompt": "2"}}
