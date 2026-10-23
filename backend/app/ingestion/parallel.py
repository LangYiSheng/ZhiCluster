"""Small bounded map primitive; callbacks and persistence stay on the caller."""

from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import TypeVar

T = TypeVar("T")
R = TypeVar("R")


def bounded_map(function: Callable[[T], R], values: Iterable[T], workers: int) -> Iterator[tuple[T, R]]:
    iterator = iter(values)
    with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="summary") as executor:
        pending = {}

        def enqueue() -> bool:
            try:
                value = next(iterator)
            except StopIteration:
                return False
            pending[executor.submit(function, value)] = value
            return True

        try:
            for _ in range(max(1, workers)):
                if not enqueue():
                    break
            while pending:
                completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    value = pending.pop(future)
                    yield value, future.result()
                for _ in completed:
                    enqueue()
        finally:
            for future in pending:
                future.cancel()
