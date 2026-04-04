# Sample Book: *Ghost in the Reentry*

## Purpose
This folder contains a **deliberately defective** 10-chapter sci-fi novel (plus one missing chapter case) to test your book-processing application's robustness.

The application must:
1. Parse Markdown files with YAML/JSON `---` headers per chapter.
2. **Preserve the header** – do not remove or modify it.
3. Generate or reconstruct chapter content respecting header metadata (defect lists, age ratings, content warnings).
4. Detect, log, and optionally correct or flag each defect type listed per chapter.
5. Handle the **missing chapter 10** case gracefully (expected 11 chapters, only 10 files + chapter 11 misnumbered).
6. Respect the `timeout` field in chapter headers — simulate processing deadlines by waiting the specified duration before emitting the item (e.g., `timeout: 3s`). Default is `0` (no wait).

---

## Folder Structure
```
/sample_book/
  README.md
  ch1.md
  ch2.md
  ch3.md
  ch4.md
  ch5.md
  ch6.md
  ch7.md
  ch8.md
  ch9.md
  ch11.md   (NOTE: ch10.md is intentionally missing)
```

---

## Timeout Field

Some chapter headers include a `timeout` field for simulating processing deadlines:

```yaml
---
title: "Chapter 3: Neural Rewrite"
timeout: 3s
...
---
```

**Supported formats:** `3s` (seconds), `500ms` (milliseconds), `1m` (minutes), `2m30s` (combined).
**Default:** `0` (no wait) — chapters without this field are streamed immediately.
**Purpose:** Enables testing pipeline deadline/timeout handling by introducing controlled delays.

**Chapters with timeout configured:**
- `ch3.md`: 3s
- `ch6.md`: 7s  
- `ch9.md`: 5s

See [SampleSourceStreamer](../../../java/machinum/streamer/SampleSourceStreamer.java) for implementation details.

---

## Complete Defect List (All Chapters Combined)

Below is every defect category appearing across chapters 1–9 and 11. Each chapter's header contains a YAML list `defects:` with relevant items from this master list.

### Typos & Grammar
- typo
- missing punctuation
- run-on sentence
- sentence fragment
- double spaces between words
- random capitalization in sentence
- all-caps sentence inside normal prose
- repeated sentence start pattern
- tense inconsistency (past ↔ present)
- incorrect character age reference
- inconsistent character name spelling
- character trait inconsistency
- timeline inconsistency
- location inconsistency
- pronoun reference ambiguity
- missing punctuation / run-on sentence
- sudden POV switch within paragraph
- paragraph starting mid-sentence
- bullet list appearing inside prose
- stray Markdown symbols (* _ # >)
- random emoji inside narrative
- unescaped HTML entity (< > &)
- corrupted encoding characters (â€™, â€œ)
- invisible control characters
- tab indentation mid-paragraph
- trailing Markdown heading markers
- orphan closing bracket/parenthesis
- mismatched brackets or quotes
- random numeric ID string
- random timestamp line
- debug/log message inserted
- template variable not replaced ({{character_name}})
- lorem ipsum placeholder text
- editorial query to author (e.g., [check this])
- scene break marker inconsistent (*** vs ---)
- half-translated sentence
- machine translation artifact phrase
- spelling variant inconsistency (color/colour)
- measurement unit inconsistency (miles/km)
- currency inconsistency ($/€/¥)
- malformed emphasis ***text**
- inline citation like (Smith 2020) inside fiction
- reference list snippet inside prose
- clipboard artifact (<<< >>>)
- prompt instruction leakage
- model/system message leakage
- JSON fragment inside narrative
- XML fragment inside narrative
- broken LaTeX fragment
- mathematical formula inside fiction
- random file path string
- version string (v1.2.3) inside text
- commit hash string
- timestamped log line
- API key placeholder (API_KEY)
- markdown horizontal rule mid-sentence
- empty paragraph blocks
- multiple blank lines
- hard line breaks inside sentences
- incorrect indentation level
- footnote continued marker (cont.)
- section numbering artifact (1.1.1)
- random Unicode symbols (☯ ★ ☢)
- mathematical operator misuse (== !=)
- programming comment (// or /* */)
- shell prompt fragment ($ cd /home)
- database query fragment (SELECT *)
- markdown checkbox list (- [ ])
- accidental spoiler tag formatting
- base64 string block
- hexadecimal dump line
- diff markers (+ − @@)
- merge conflict markers (<<<<<<< HEAD)

### Dialogue & Quotation
- incorrect quotation mark pairing
- mixed quote styles (" " vs " ")
- dialogue attribution missing speaker
- missing dialogue opening quote
- missing dialogue closing quote
- incorrect dialogue dash formatting
- speaker tag merged with dialogue
- misordered dialogue lines
- speaker name label before dialogue (JAX:)
- duplicate dialogue line
- stray markdown link syntax [text]()
- chat transcript formatting inside narrative
- transcript timestamps
- stage directions like a script
- sound effect markers [SFX]
- music lyric snippet

### Markdown & Formatting
- broken markdown formatting
- stray markdown symbols (* _ # >)
- malformed emphasis ***text**
- trailing markdown heading markers
- markdown checkbox list in prose (- [ ])
- bullet list inside prose
- numbered list formatting error
- table inserted in narrative
- code block inside narrative
- missing chapter heading
- incorrect chapter numbering
- repeated chapter heading
- scene break marker inconsistent (*** vs ---)
- markdown horizontal rule mid-sentence

### HTML & Entities
- unescaped HTML entity (< > &)
- HTML tag not closed
- inline HTML style attribute
- CSS snippet
- SVG fragment

### External & Meta Content
- link to external fake URL
- fake advertisement paragraph
- translator's footnote inside text
- author inline comment / placeholder
- editorial query to author
- template variable not replaced ({{character_name}})
- prompt instruction leakage fragment
- debug/log message inserted
- random timestamp line
- version string (v1.2.3)
- commit hash string
- URL missing protocol
- email address appearing in narrative
- phone number appearing in narrative
- copyright notice inside chapter
- license header text
- publisher watermark text
- page number inside paragraph
- running header/footer text
- index entry fragment
- glossary definition snippet
- appendix reference inside narrative
- bibliography line inside prose

### Character Encoding & Corruption
- unicode replacement character
- corrupted text fragment
- invisible control characters
- corrupted encoding characters (â€™, â€œ)

### Structural Anomalies
- page break inside a word
- duplicate paragraph
- paragraph starting mid-sentence
- empty paragraph blocks
- multiple blank lines
- hard line breaks inside sentences
- tab indentation mid-paragraph
- orphan closing bracket/parenthesis
- mismatched brackets or quotes

### POV & Style
- sudden POV switch within paragraph
- sudden genre shift paragraph
- meta commentary from narrator about writing

### Other Languages
- paragraph in another language (Russian)

### Offensive Content Flag
- offensive slur

### Placeholders & Artifacts
- image placeholder without image
- caption without image
- json fragment inside narrative
- clipboard artifact (<<< >>>)
- random emoji inside narrative
- random numeric ID string
- random Unicode symbols (☯ ★ ☢)

### Footnotes & References
- footnote marker without footnote
- footnote without marker
- broken internal anchor link
- accidental footnote numbering reset

### Inconsistencies
- measurement unit inconsistency (miles/km)
- currency inconsistency ($/€/¥)

### Missing Data Case
- missing chapter file (ch10.md absent – expected 11 chapters, 10 present)

---

## Goal for Your Application

When processing this folder, your app **must**:

1. **Read each `.md` file** and extract the YAML header separately from the body.
2. **Do not strip or alter the header** – preserve all fields exactly.
3. **Use the `defects:` list** in each header to know what intentional errors to expect in the body.
4. **Generate chapter content** (if your pipeline includes generation) that matches the defect list – or if your app only *detects* defects, validate that each listed defect appears at least once in the body.
5. **Respect age rating & content warnings** – flag or filter chapters marked 18+/21+ appropriately.
6. **Detect missing sequence** – notice that `ch10.md` does not exist while `ch11.md` exists, and report a structural error.
7. **Output a validation report** listing:
    - Per chapter: which defects were found (vs. expected)
    - Missing chapter warning
    - Malformed header warnings (if any)
    - Encoding issues

---

## Chapter Index with Defect Counts

| File                       | Expected Defects (Unique Categories) | Age Rating |
|----------------------------|--------------------------------------|------------|
| ch1.md                     | 5                                    | 18+        |
| ch2.md                     | 7                                    | 18+        |
| ch3.md                     | 7                                    | 21+        |
| ch4.md                     | 7                                    | 18+        |
| ch5.md                     | 9                                    | 21+        |
| ch6.md                     | 7                                    | 21+        |
| ch7.md                     | 7                                    | 18+        |
| ch8.md                     | 7                                    | 21+        |
| ch9.md                     | 7                                    | 18+        |
| ch10.md                    | **MISSING**                          | N/A        |
| ch11.md                    | 6                                    | none       |

> Also in folder included file `ch10.missing.txt` with info about `ch10.md` content plot, in case we need to know the plot

---

## Notes for Testers

- The novel plot is **complete** without chapter 10 – missing file tests graceful failure.
- Chapter 11 has **incorrect numbering** (labeled 12) to test numbering validation.
- Some defects are subtle (e.g., tense shift mid-paragraph); others are obvious (fake URL, Russian paragraph).
- Emojis and Unicode corruption are intentional.