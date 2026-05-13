import { describe, expect, it } from 'vitest'

import parseMessage from './httpParser.js'

describe('httpParser body parsing', () => {
  it('should keep the full JSON body when Content-Length header is present', () => {
    const body = '{"characteristics":[{"aid":1,"iid":2,"value":true}]}'
    const message = [
      'EVENT/1.0 200 OK',
      'Content-Type: application/hap+json',
      `Content-Length: ${body.length}`,
      '',
      body,
    ].join('\r\n')

    const result = parseMessage(message)
    expect(result.body).toBe(body)
  })

  it('should keep the full multi-line JSON body when Content-Length is missing', () => {
    const body = '{\n  "characteristics": [\n    {"aid":1,"iid":2,"value":true}\n  ]\n}'
    const message = [
      'EVENT/1.0 200 OK',
      'Content-Type: application/hap+json',
      '',
      body,
    ].join('\r\n')

    const result = parseMessage(message)

    // Without the fix `body.split('\n')[1]` only kept the second line
    // (`  "characteristics": [`), losing every line after that — making
    // the resulting JSON unparseable.
    expect(result.body).toContain('characteristics')
    expect(result.body).toContain('"value":true')
    expect(() => JSON.parse(result.body!)).not.toThrow()
  })
})
