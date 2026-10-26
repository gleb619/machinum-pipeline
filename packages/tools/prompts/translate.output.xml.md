## Output contract (xml mode)

Return the result as XML. Each translated line is wrapped in a <result> block that contains:

- <id>: the same numeric identifier as in the input
- <translated>: the corresponding {{targetLang}} translation in plain text

Only output XML. Do not include any explanation, comments, notes, examples, thoughts or formatting outside the XML.
Never omit any <result> element, and never alter the <id> values. Translate only the <origin> value for each given
<id>, and place the result in <translated>.
