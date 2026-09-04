"""The other half of the cycle: it imports ``a`` back, which closes the loop."""

from tiny.cycle_a import a

__all__ = ["b"]


def b() -> int:
    return 1


def unlisted() -> int:
    """Public by name, absent from ``__all__``: not exported."""
    return len(a.__doc__ or "")
