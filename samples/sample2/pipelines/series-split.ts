import { definePipeline } from '@mt/core'
import { seriesSplitTool } from '@mt/tools'
import '@mt/waypoint'

export const seriesSplitPipeline = definePipeline({ id: 'series-split' })
  .from('md://./books/book1/chapter-6.en.md')
  .use(seriesSplitTool)
  .to('md://./chapters/series-output.md')

export default seriesSplitPipeline
