import * as vscode from 'vscode'

interface DSLDocumentation {
  [key: string]: string
}

const DSL_DOCS: DSLDocumentation = {
  definePipeline:
    '**definePipeline(config)** — Define a new pipeline.\n\n```ts\ndefinePipeline({ name: string, description?: string }, (p) => { ... })\n```',
  use: '**.use(tool, options?)** — Add a tool step to the pipeline.\n\nReturns PipelineBuilder for chaining.',
  fork: '**.fork(name, branches)** — Fork execution into N parallel branches.\n\n\nEach branch is an independent sub-pipeline.',
  tap: '**.tap(fn)** — Side-effect step that passes items through unchanged.',
}

export class HoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text
    const wordRange = document.getWordRangeAtPosition(position)

    if (!wordRange) {
      return null
    }

    for (const [symbol, docs] of Object.entries(DSL_DOCS)) {
      if (line.includes(symbol)) {
        const matchRegex = new RegExp(`\\b${symbol}\\b`, 'g')
        if (matchRegex.test(line)) {
          const markdown = new vscode.MarkdownString(docs)
          return new vscode.Hover(markdown, wordRange)
        }
      }
    }

    return null
  }
}
