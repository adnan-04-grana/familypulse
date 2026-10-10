import ts from 'typescript'
import { readFileSync } from 'node:fs'

const fileName = 'server/index.mjs'
const source = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
for (const diagnostic of source.parseDiagnostics) {
  const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  console.log(`${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
}
const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.text)
const braces = []
let token = scanner.scan()
while (token !== ts.SyntaxKind.EndOfFileToken) {
  if (token === ts.SyntaxKind.OpenBraceToken) {
    const position = scanner.getTokenPos()
    braces.push(position)
    const line = source.getLineAndCharacterOfPosition(position).line + 1
    if (line >= 389 && line <= 430) console.log(`{ ${line}:${source.getLineAndCharacterOfPosition(position).character + 1}`)
  }
  if (token === ts.SyntaxKind.CloseBraceToken) {
    const position = scanner.getTokenPos()
    const line = source.getLineAndCharacterOfPosition(position).line + 1
    if (line >= 389 && line <= 430) console.log(`} ${line}:${source.getLineAndCharacterOfPosition(position).character + 1}`)
    braces.pop()
  }
  token = scanner.scan()
}
for (const position of braces) {
  const location = source.getLineAndCharacterOfPosition(position)
  console.log(`Unclosed brace at ${location.line + 1}:${location.character + 1}`)
}