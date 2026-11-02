import { rolldown } from 'rolldown'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.dirname(fileURLToPath(import.meta.url))
const build = await rolldown({ input: path.join(root, 'document-export.ts'), platform: 'browser' })
try {
  // Keep dependency Unicode ranges visible in source without changing their values.
  const result = await build.write({ file: path.join(root, '../app/static/document-export.bundle.js'), format: 'iife', name: 'BuddyExportBundle', codeSplitting: false, minify: { codegen: { asciiOnly: true } } })
  if (result.output.some(chunk => chunk.type === 'chunk' && /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(chunk.code))) {
    throw new Error('Document export bundle contains an unescaped bidirectional control character')
  }
} finally {
  await build.close()
}
