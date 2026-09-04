"""One half of the fixture's single import cycle."""

from tiny.cycle_b import b


def a() -> int:
    return b() + 1
