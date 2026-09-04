"""The entry point: an absolute import, a relative import and a module alias."""

import tiny.retry as r
from tiny.store import Store

from . import retry


def main() -> None:
    store = Store()
    store.put("a", 1)
    retry(main)


def boot() -> None:
    r.retry(main)
