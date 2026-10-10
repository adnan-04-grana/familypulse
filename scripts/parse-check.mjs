import ts from 'typescript'
import { readFileSync } from 'node:fs'

const fileName = 'server/index.mjs'
const source = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
for (const diagnostic of source.parseDiagnostics) {
  const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  console.log(`${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
}