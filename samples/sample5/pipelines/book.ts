import { definePipeline } from '@mt/core'
import { bookCompiler } from '@mt/tools'
import '@mt/waypoint'

// === book: assemble the chapter files back into one book ===
// The pipeline splits a book into chapters but never put them back together. `bookCompiler`
// collects the chapter files into one BookDoc (chapters, table of contents, completeness
// warnings); `book://` writes the artifact — book.md (the book) and book.json (TOC + warnings).
// Judge: the TOC lists every chapter in order, the anchors point at the chapter headings.
export default definePipeline({ id: 'book' })
  .from('md://./input/en')
  .batch(100)
  .use(bookCompiler)
  .to('book://./chapters/book')
