import { definePipeline } from '@mt/core'
import '@mt/tools'
import '@mt/waypoint'

export const seriesSplitPipeline = definePipeline({ id: 'series-split' })
  .from('md://./books/book1/chapter-6.en.md')
  .subflow('#series') // same splitter as `.subflow('series')` / `.subflow('series://')`
  .to('md://./chapters/series-output.md')

export default seriesSplitPipeline
