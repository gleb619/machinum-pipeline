# The Structure Ladder

---

A chunk is the largest piece of text that still fits one request. The
splitter groups paragraphs, so a paragraph is never cut.

---

Chunks are written back with a separator line between them. That separator
is what makes a second run cheap: an already separated text stays as it is.
The chunks never move.

The ladder walks the same document down through chunks, paragraphs, lines
and words. Every rung hands its envelopes to the next one and counts them.
