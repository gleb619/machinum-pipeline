import { definePipeline } from '@mt/core'
import { tokenSplitter } from '@mt/tools'
import '@mt/waypoint'
import { SERIES_SPLIT_PARTS } from '../constants.js'

export const seriesSplitPipeline = definePipeline({ id: 'series-split' })
  .from('md://./books/book1/chapter-6.en.md')
  .use(tokenSplitter.with({ maxTokens: 200 }))
  .to('md://./chapters/series-output.md')

export default seriesSplitPipeline
