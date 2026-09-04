"""Excluded from the index by ``DEFAULT_CONFIG.exclude`` (``**/__tests__/**``).

The fixture keeps it so a run that indexes it is a visible failure: six Python files
are indexed, not seven.
"""

from tiny.store import Store


def test_put() -> None:
    store = Store()
    store.put("a", 1)
