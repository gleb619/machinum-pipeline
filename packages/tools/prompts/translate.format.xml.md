## Input format (xml mode)

The text is organized into lines/paragraphs. Each line is wrapped in a <result> block that contains:

- <id>: a unique numeric identifier of the line
- <origin>: the original {{sourceLang}} line (including TL notes, comments, formatting) in plain text

Translate each <origin> line from {{sourceLang}} to {{targetLang}} and keep the line structure exactly. Use the provided
glossary for names, items, and terms; after translating, reread the output to refine awkward phrasing and improve
naturalness.
