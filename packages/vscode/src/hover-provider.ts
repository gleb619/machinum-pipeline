import * as vscode from 'vscode'
import { docsFor } from './dsl-docs'

export class HoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const wordRange = document.getWordRangeAtPosition(position)

    if (!wordRange) {
      return null
    }

    const word = document.getText(wordRange)
    const precedingChar =
      wordRange.start.character > 0
        ? document.getText(new vscode.Range(wordRange.start.translate(0, -1), wordRange.start))
        : ''
    const docs = docsFor(word, precedingChar)

    if (!docs) {
      return null
    }

    return new vscode.Hover(new vscode.MarkdownString(docs), wordRange)
  }
}
