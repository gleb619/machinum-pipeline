import * as vscode from 'vscode'
import { CodeLensProvider } from './codelens-provider'
import { HoverProvider } from './hover-provider'

export function activate(context: vscode.ExtensionContext): void {
  // Register HoverProvider for TypeScript files
  const hoverProvider = new HoverProvider()
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'typescript' }, hoverProvider),
  )

  // Register CodeLensProvider for pipeline files
  const codeLensProvider = new CodeLensProvider()
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/pipelines/*.ts' }, codeLensProvider),
  )

  // Register command to run pipelines
  context.subscriptions.push(
    vscode.commands.registerCommand('mt.runPipeline', async (args) => {
      const filePath = args?.file as string | undefined
      if (!filePath) {
        vscode.window.showErrorMessage('No file path provided')
        return
      }

      const terminal = vscode.window.createTerminal('Mt Pipeline')
      terminal.sendText(`npx mt run "${filePath}"`)
      terminal.show()
    }),
  )

  vscode.window.showInformationMessage('Mt Pipeline extension activated')
}

export function deactivate(): void {
  // Cleanup if needed
}
