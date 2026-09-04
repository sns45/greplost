"""Retrying a callable. ``_backoff`` is private and never exported."""

DEFAULT_ATTEMPTS = 3


def retry(fn, attempts: int = DEFAULT_ATTEMPTS):
    """Call ``fn`` until it stops raising, at most ``attempts`` times."""
    for step in range(attempts):
        try:
            return fn()
        except RuntimeError:
            _backoff(step)
    return None


def _backoff(step: int) -> float:
    return 0.1 * step
