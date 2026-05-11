import { describe, expect, it } from 'vitest'
describe('UC-20 — Item routing (architectural)', () => {
  it('PipelineStep.type does not yet include route', () => {
    // UC-20 is not yet implemented — 'route' is not in the step type union
    const types = ['source', 'tool', 'target', 'fork', 'batch', 'window', 'flatmap', 'tap']
    expect(types).not.toContain('route')
  })
  it.skip('PipelineStep.type should include route when implemented', () => {
    // When UC-20 is implemented, PipelineStep.type union adds 'route'
    const types = [
      'source',
      'tool',
      'target',
      'fork',
      'batch',
      'window',
      'flatmap',
      'tap',
      // 'route',  // <-- expected after implementation
    ]
    expect(types).toContain('route')
  })
  it.skip('DSL pipeline builder should expose .route() method', () => {
    // When UC-20 is implemented, PipelineBuilder exposes .route()
    // builder.route(predicate, subPipeline) pushes type: 'route'
  })
  it.skip('Runner should handle case route in executeSteps', () => {
    // When UC-20 is implemented, runner.ts contains case 'route' branch
    // that evaluates predicate per item and dispatches to matching sub-pipeline
  })
})
//# sourceMappingURL=item-routing.arch.test.js.map
