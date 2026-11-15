import { Buffer } from 'node:buffer'

/** One message read from the monitor socket: an HTTP response or a HAP `EVENT`. */
export interface HttpMessage {
  /** `HTTP` for a response, `EVENT` for a HAP event; null when the text is neither */
  protocol: 'HTTP' | 'EVENT' | null
  httpVersion: number | null
  statusCode: number | null
  statusMessage: string | null
  /** Header names in lower case; null when there are none */
  headers: Record<string, string> | null
  /** Everything after the blank line that ends the headers; null when there is nothing */
  body: string | null
}

// The text after the status code and after a header's colon is trimmed below
const STATUS_LINE_REGEX = /^(HTTP|EVENT)\/(\d\.\d)[ \t]+(\d{3})(.*)$/i
const HEADER_REGEX = /^([\w-]+):(.*)$/

/**
 * Parses one complete message as the monitor cuts it out of the socket data
 * (see findMessageBoundary). The body is returned as it came: the caller knows
 * it is JSON.
 */
export default function parseMessage(message: string | Buffer): HttpMessage {
  const result: HttpMessage = {
    protocol: null,
    httpVersion: null,
    statusCode: null,
    statusMessage: null,
    headers: null,
    body: null,
  }

  const text = (Buffer.isBuffer(message)
    ? message.toString('utf8')
    : String(message ?? '')).replace(/^\s+/, '')

  const separator = text.match(/\r?\n\r?\n/)
  const head = separator?.index === undefined
    ? text
    : text.slice(0, separator.index)
  const [statusLine, ...headerLines] = head.split(/\r?\n/)

  const status = statusLine.match(STATUS_LINE_REGEX)
  if (!status) {
    return result
  }
  result.protocol = status[1].toUpperCase() as 'HTTP' | 'EVENT'
  result.httpVersion = Number.parseFloat(status[2])
  result.statusCode = Number.parseInt(status[3], 10)
  result.statusMessage = status[4].trim()

  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const header = line.match(HEADER_REGEX)
    if (header) {
      headers[header[1].toLowerCase()] = header[2].trim()
    }
  }
  if (Object.keys(headers).length) {
    result.headers = headers
  }

  if (separator?.index !== undefined) {
    result.body = text.slice(separator.index + separator[0].length) || null
  }

  return result
}
