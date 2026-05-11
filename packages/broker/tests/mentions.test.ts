import { describe, test, expect } from 'bun:test'
import { EVERYONE, parseMentions } from '../src/mentions.ts'

describe('parseMentions', () => {
  test('extracts a single mention at the start of text', () => {
    expect(parseMentions('@Bob can you check')).toEqual(['Bob'])
  })

  test('extracts multiple mentions preceded by whitespace', () => {
    expect(parseMentions('hi @Bob and @Alice')).toEqual(['Bob', 'Alice'])
  })

  test('ignores `@` not preceded by whitespace (email-like input)', () => {
    expect(parseMentions('contact me at user@example.com')).toEqual([])
  })

  test('deduplicates repeated mentions', () => {
    expect(parseMentions('@Bob ping @Bob again')).toEqual(['Bob'])
  })

  test('accepts hyphens and underscores in names', () => {
    expect(parseMentions('@mod-dev @snake_case')).toEqual(['mod-dev', 'snake_case'])
  })

  test('stops the name at punctuation', () => {
    expect(parseMentions('@Bob, please review')).toEqual(['Bob'])
  })

  test('recognises the @everyone literal', () => {
    expect(parseMentions('@everyone heads up')).toEqual([EVERYONE])
  })

  test('returns empty for text with no mentions', () => {
    expect(parseMentions('just a plain message')).toEqual([])
  })

  test('rejects names that do not start with a letter', () => {
    expect(parseMentions('@123abc')).toEqual([])
  })
})
