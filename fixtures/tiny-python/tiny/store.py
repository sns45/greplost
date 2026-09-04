"""A tiny in-memory store: a class, a method, a private method and a constant."""

DEFAULT_SIZE = 128


class Store:
    """Holds at most ``DEFAULT_SIZE`` items."""

    def __init__(self, size: int = DEFAULT_SIZE) -> None:
        self.size = size
        self.items: dict[str, object] = {}

    def put(self, key: str, value: object) -> None:
        self._record(key)
        self.items[key] = value

    def _record(self, key: str) -> None:
        """Not part of the package surface: the name starts with an underscore."""
