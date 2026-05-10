import { describe, expect, it } from 'vitest'
import { entitiesTool, schemaTool, summaryTool } from './schema-doc.js'

describe('summaryTool', () => {
  it('should have correct name and version', () => {
    expect(summaryTool.name).toBe('summary')
    expect(summaryTool.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof summaryTool.invoke).toBe('function')
  })
})

describe('entitiesTool', () => {
  it('should have correct name and version', () => {
    expect(entitiesTool.name).toBe('entities')
    expect(entitiesTool.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof entitiesTool.invoke).toBe('function')
  })
})

describe('schemaTool', () => {
  it('should have correct name and version', () => {
    expect(schemaTool.name).toBe('schema')
    expect(schemaTool.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof schemaTool.invoke).toBe('function')
  })
})
