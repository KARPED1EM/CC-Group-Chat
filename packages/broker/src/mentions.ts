// Mention syntax: `@<name>` where <name> matches the member name pattern.
// The `@` must be preceded by start-of-string or whitespace so that strings
// such as `user@example.com` are not misparsed as mentions. Mentions inside
// backtick code spans (`...`) and fenced code blocks (```...```) are skipped,
// and the escape sequence `\@name` is treated as literal text.

const NAME_REGEX = /^@([A-Za-z][A-Za-z0-9_-]*)/

export const EVERYONE = 'everyone'

export function parseMentions(text: string): readonly string[] {
  const found = new Set<string>()
  let i = 0
  let inFencedCode = false
  let inInlineCode = false

  while (i < text.length) {
    if (!inInlineCode && text.startsWith('```', i)) {
      inFencedCode = !inFencedCode
      i += 3
      continue
    }
    if (!inFencedCode && text[i] === '`') {
      inInlineCode = !inInlineCode
      i += 1
      continue
    }
    if (inFencedCode || inInlineCode) {
      i += 1
      continue
    }
    if (text[i] === '\\' && text[i + 1] === '@') {
      i += 2
      continue
    }
    if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const match = NAME_REGEX.exec(text.slice(i))
      if (match) {
        found.add(match[1]!)
        i += match[0].length
        continue
      }
    }
    i += 1
  }

  return [...found]
}
