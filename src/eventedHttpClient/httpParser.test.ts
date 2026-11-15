import { Buffer } from 'node:buffer'

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

  it('reads the protocol, version, status and headers of an event', () => {
    const result = parseMessage('EVENT/1.0 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: 2\r\n\r\n{}')

    expect(result).toEqual({
      protocol: 'EVENT',
      httpVersion: 1,
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'application/hap+json', 'content-length': '2' },
      body: '{}',
    })
  })

  it('reads a response without a body, such as the 204 that answers a subscription', () => {
    const result = parseMessage('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n')

    expect(result.protocol).toBe('HTTP')
    expect(result.statusCode).toBe(204)
    expect(result.statusMessage).toBe('No Content')
    expect(result.body).toBeNull()
  })

  it('reads a status which has no text, such as the 470 of a refused pin', () => {
    const result = parseMessage('HTTP/1.1 470 \r\nContent-Type: application/hap+json\r\n\r\n{"status":-70401}')

    expect(result.statusCode).toBe(470)
    expect(result.statusMessage).toBe('')
    expect(result.body).toBe('{"status":-70401}')
  })

  it('accepts a buffer and keeps characters of more than one byte in the body', () => {
    const body = '{"characteristics":[{"aid":1,"iid":2,"value":"Küche ☀"}]}'
    const result = parseMessage(Buffer.from(`EVENT/1.0 200 OK\nContent-Type: application/hap+json\n\n${body}`))

    expect(result.protocol).toBe('EVENT')
    expect(result.body).toBe(body)
  })

  it('names no protocol for text which is not a response or an event', () => {
    // What is left of a chunked 207 body after its headers were cut off
    const result = parseMessage('57\r\n{"characteristics":[]}\r\n0\r\n\r\n')

    expect(result.protocol).toBeNull()
    expect(result.statusCode).toBeNull()
    expect(result.body).toBeNull()
  })
})
