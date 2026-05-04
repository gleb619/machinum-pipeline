import * as vscode from 'vscode'

const DEFINE_PIPELINE_PATTERN = /definePipeline\s*\(/g

export class CodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = []
    const text = document.getText()
    const matches = text.matchAll(DEFINE_PIPELINE_PATTERN)

    for (const match of matches) {
      const index = match.index
      if (index === undefined) {
        continue
      }

      const position = document.positionAt(index)
      const range = new vscode.Range(position, position)

      const codeLens = new vscode.CodeLens(range, {
        title: '▶ Run pipeline',
        command: 'mt.runPipeline',
        arguments: [{ file: document.uri.fsPath }],
      })

      codeLenses.push(codeLens)
    }

    return codeLenses
  }
}
