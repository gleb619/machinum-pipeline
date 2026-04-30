import { describe, it, expect, vi } from 'vitest'
import { toolCommand } from '../../src/commands/tool.js'

describe('toolCommand', () => {
  it('should print usage and exit if no tool name provided', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`)
    })

    await expect(toolCommand([])).rejects.toThrow('process.exit: 1')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mt tool <name>'))
    
    consoleSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
