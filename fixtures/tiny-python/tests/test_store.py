"""Excluded from the index by ``DEFAULT_CONFIG.exclude`` (``**/test_*.py``).

The fixture keeps it so a run that indexes it is a visible failure: the seven modules
under ``tiny/`` are indexed, and this file is not.
"""

from tiny.store import Store


def test_put() -> None:
    store = Store()
    store.put("a", 1)
