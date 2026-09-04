"""The one dynamic-import form Python has, in both of its spellings."""

import importlib
from importlib import import_module

PLUGIN = "tiny.retry"


def load_retry():
    """A string literal names a module the map can point at."""
    return importlib.import_module("tiny.retry")


def load_store():
    """The bare-name spelling resolves the same way."""
    return import_module("tiny.store")


def load_named(name: str):
    """A computed argument names no module: neither side records anything."""
    return importlib.import_module(name)


def load_configured():
    """A module-level constant is still not a literal at the call site."""
    return importlib.import_module(PLUGIN)
