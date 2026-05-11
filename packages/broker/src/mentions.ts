// Mention syntax: `@<name>` where <name> matches the member name pattern.
// The `@` must be preceded by start-of-string or whitespace so that strings
// such as `user@example.com` are not misparsed as mentions.

const MENTION_PATTERN = /(?:^|\s)@([A-Za-z][A-Za-z0-9_-]*)/g

export const EVERYONE = 'everyone'

export function parseMentions(text: string): readonly string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    found.add(match[1]!)
  }
  return [...found]
}
