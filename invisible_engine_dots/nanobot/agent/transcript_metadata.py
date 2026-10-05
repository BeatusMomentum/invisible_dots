"""The key under which a runner's callers ride metadata in a transcript message.

The runner keeps it out of the transcript the model reads and hands it to its
checkpoint callback; the Dot layer reads and writes the entries.
"""

from __future__ import annotations

# The key under which the engine's own metadata rides in a transcript message.
METADATA_KEY = "_dots"
# tool result: the call failed.
IS_ERROR = "is_error"
