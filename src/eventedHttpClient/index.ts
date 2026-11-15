/**
 * The contents in this file were taken from NorthernMan54/Hap-Node-Client
 * https://github.com/NorthernMan54/Hap-Node-Client/blob/master/lib/eventedHttpClient.js
 */

import { Buffer } from 'node:buffer'
import { createConnection as netCreateConnection } from 'node:net'

import httpMessageParser from './httpParser.js'

export const parseMessage = httpMessageParser

/** How long the monitor socket may be idle before the system starts to probe it. */
const KEEP_ALIVE_DELAY_MS = 30000

export function createConnection(instance, pin: string, body, onPacket?: (packet: Buffer) => void) {
  const client = netCreateConnection({
    host: instance.ipAddress,
    port: instance.port,
  })
  // The bridge only writes to this socket when a value changes, so a bridge
  // whose machine lost power or network would leave it open for ever. With
  // keep-alive the system probes an idle connection and closes a dead one.
  client.setKeepAlive(true, KEEP_ALIVE_DELAY_MS)

  const message = _buildMessage({
    method: 'PUT',
    url: `http://${instance.ipAddress}:${instance.port}/characteristics`,
    headers: {
      'Content-Type': 'application/json',
      'authorization': pin,
      'connection': 'keep-alive',
    },
    body: JSON.stringify(body),
  })
  onPacket?.(Buffer.from(message))
  client.write(message)

  return client
}

function _headersToString(headers) {
  let response = ''

  for (const header of Object.keys(headers)) {
    response = `${response + header}: ${headers[header]}\r\n`
  }
  return response
}

function _buildMessage(request) {
  const context = new URL(request.url)
  let message

  message = `${request.method} ${context.pathname}`
  if (context.search) {
    message = message + context.search
  }
  message = `${message} HTTP/1.1\r\nHost: ${context.host}\r\n${_headersToString(request.headers)}`
  if (request.body) {
    const contentLength = Buffer.byteLength(request.body, 'utf8')
    message = `${message}Content-Length: ${contentLength}\r\n\r\n${request.body}`
  } else {
    message = `${message}\r\n\r\n`
  }
  return message
}
