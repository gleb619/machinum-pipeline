## Input format (xml mode)

The text is organized into lines/paragraphs. Each line is wrapped in a <result> block that contains:

- <id>: a unique numeric identifier of the line (1-based, contiguous)
- <origin>: the original line (including notes, comments, formatting) in plain text

Process each <origin> line and keep the line structure exactly: one output block per input line,
with the same <id>.
