/**
 * The contents in this file were taken from NorthernMan54/Hap-Node-Client
 * https://raw.githubusercontent.com/NorthernMan54/Hap-Node-Client/master/lib/httpParser.js
 */

import { Buffer } from 'node:buffer'

// Borrowed and heavily modified from https://github.com/miguelmota/http-message-parser

function httpMessageParser(message) {
  const result = {
    protocol: null,
    httpVersion: null,
    statusCode: null,
    statusMessage: null,
    method: null,
    url: null,
    headers: null,
    body: null,
    boundary: null,
    multipart: null,
    additional: null,
  }

  let messageString = ''
  let headerNewlineIndex = 0
  let fullBoundary = null

  if (httpMessageParser._isBuffer(message)) {
    messageString = message.toString()
  } else if (typeof message === 'string') {
    messageString = message
    message = httpMessageParser._createBuffer(messageString)
  } else {
    return result
  }

  /*
   * Strip extra return characters
   */
  messageString = messageString.replace(/\r\n/g, '\n');

  /*
   * Trim leading whitespace
   */
  (function () {
    const firstNonWhitespaceRegex = /[\w-]+/g
    const firstNonWhitespaceIndex = messageString.search(firstNonWhitespaceRegex)
    if (firstNonWhitespaceIndex > 0) {
      message = message.slice(firstNonWhitespaceIndex, message.length)
      messageString = message.toString()
    }
  })();

  /* Parse request line
   */
  (function () {
    const possibleRequestLine = messageString.split(/\n|\r\n/)[0]
    const requestLineMatch = possibleRequestLine.match(httpMessageParser._requestLineRegex)

    if (Array.isArray(requestLineMatch) && requestLineMatch.length > 1) {
      result.protocol = requestLineMatch[1]
      result.httpVersion = Number.parseFloat(requestLineMatch[2])
      result.statusCode = Number.parseInt(requestLineMatch[3], 10)
      result.statusMessage = requestLineMatch[4]
    } else {
      const responseLineMath = possibleRequestLine.match(httpMessageParser._responseLineRegex)
      if (Array.isArray(responseLineMath) && responseLineMath.length > 1) {
        result.method = responseLineMath[1]
        result.url = responseLineMath[2]
        result.httpVersion = Number.parseFloat(responseLineMath[3])
      }
    }
  })();

  /* Parse headers
   */
  (function () {
    headerNewlineIndex = messageString.search(httpMessageParser._headerNewlineRegex)
    if (headerNewlineIndex > -1) {
      headerNewlineIndex = headerNewlineIndex + 1 // 1 for newline length
    } else {
      /* There's no line breaks so check if request line exists
       * because the message might be all headers and no body
       */
      if (result.httpVersion) {
        headerNewlineIndex = messageString.length
      }
    }

    const headersString = messageString.substring(0, headerNewlineIndex)
    const headers = httpMessageParser._parseHeaders(headersString)

    if (Object.keys(headers).length > 0) {
      result.headers = headers

      // TOOD: extract boundary.
    }
  })();

  /* Try to get boundary if no boundary header
   */
  (function () {
    if (!result.boundary) {
      const boundaryMatch = messageString.match(httpMessageParser._boundaryRegex)

      if (Array.isArray(boundaryMatch) && boundaryMatch.length) {
        fullBoundary = boundaryMatch[0].replace(/[\r\n]+/g, '')
        result.boundary = fullBoundary.replace(/^--/, '')
      }
    }
  })();

  /* Parse body
   */
  (function () {
    let start = headerNewlineIndex
    let end = (result.headers && result.headers['Content-Length'] ? result.headers['Content-Length'] + start : messageString.length)
    const firstBoundaryIndex = messageString.indexOf(fullBoundary)

    if (firstBoundaryIndex > -1 && result.boundary) {
      start = headerNewlineIndex
      end = firstBoundaryIndex
    }

    if (headerNewlineIndex > -1) {
      const body = messageString.slice(start, end)
      result.additional = messageString.slice(end) // Pass back any unparsed data for running through again
      // console.log("Lengths: total %s -> start %s -> end %s -> final %s", messageString.length, start, end, body.length);

      if (body && body.length) {
        if ((result.headers && result.headers['Content-Type'] === 'application/hap+json')
          || (result.headers && result.headers['Content-Type'] === 'application/json')) {
          // JSON.parse JSON message's
          try {
            if (result.headers['Content-Length']) {
              result.body = body
            } else {
              // No Content-Length: keep the full body, only trimming the leading
              // newline that sits between headers and body.
              result.body = body.replace(/^[\r\n]+/, '')
            }
          } catch (err) {

          }
        } else {
          result.body = body
        }
      }
    }
  })();

  /* Parse multipart sections
   */
  (function () {
    if (result.boundary) {
      const multipartStart = messageString.indexOf(fullBoundary) + fullBoundary.length
      const multipartEnd = messageString.lastIndexOf(fullBoundary)
      const multipartBody = messageString.substring(multipartStart, multipartEnd)
      const splitRegex = new RegExp(`^${fullBoundary}.*[\n\r]?$`, 'gm')
      const parts = multipartBody.split(splitRegex)

      result.multipart = parts.filter(httpMessageParser._isTruthy).map((part, i) => {
        // tslint:disable-next-line: no-shadowed-variable
        const result = {
          headers: null,
          body: null,
          meta: {
            body: {
              byteOffset: {
                start: null,
                end: null,
              },
            },
          },
        }

        const newlineRegex = /\n\n|\r\n\r\n/g
        let newlineIndex = 0
        let newlineMatch = newlineRegex.exec(part)
        let body

        if (newlineMatch) {
          newlineIndex = newlineMatch.index
          if (newlineMatch.index <= 0) {
            newlineMatch = newlineRegex.exec(part)
            if (newlineMatch) {
              newlineIndex = newlineMatch.index
            }
          }
        }

        const possibleHeadersString = part.substring(0, newlineIndex)

        let startOffset = null
        let endOffset = null

        if (newlineIndex > -1) {
          const headers = httpMessageParser._parseHeaders(possibleHeadersString)
          if (Object.keys(headers).length > 0) {
            result.headers = headers

            const boundaryIndexes = []
            for (let j = 0; j >= 0;) {
              j = message.indexOf(fullBoundary, j)

              if (j >= 0) {
                boundaryIndexes.push(j)
                j += fullBoundary.length
              }
            }

            const boundaryNewlineIndexes = []
            boundaryIndexes.slice(0, boundaryIndexes.length - 1).forEach((m, k) => {
              const partBody = message.slice(boundaryIndexes[k], boundaryIndexes[k + 1]).toString()
              // tslint:disable-next-line: no-shadowed-variable
              let headerNewlineIndex = partBody.search(/\n\n|\r\n\r\n/g) + 2
              headerNewlineIndex = boundaryIndexes[k] + headerNewlineIndex
              boundaryNewlineIndexes.push(headerNewlineIndex)
            })

            startOffset = boundaryNewlineIndexes[i]
            endOffset = boundaryIndexes[i + 1]
            body = message.slice(startOffset, endOffset)
          } else {
            body = part
          }
        } else {
          body = part
        }

        result.body = body
        result.meta.body.byteOffset.start = startOffset
        result.meta.body.byteOffset.end = endOffset

        return result
      })
    }
  })()

  return result
}

httpMessageParser._isTruthy = function _isTruthy(v) {
  return !!v
}

httpMessageParser._isNumeric = function _isNumeric(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) {
    return true
  }

  v = (v || '').toString().trim()

  if (!v) {
    return false
  }

  // `v` is a string here, so coerce before the NaN check: bare `Number.isNaN`
  // never coerces and would report every non-numeric header (e.g. a
  // Content-Type) as numeric. This restores the original global `isNaN`
  // semantics that the lint autofix silently changed.
  return !Number.isNaN(Number(v))
}

httpMessageParser._isBuffer = function (item) {
  return ((httpMessageParser._isNodeBufferSupported()
    && typeof globalThis === 'object'
    && Buffer.isBuffer(item))
  || (item instanceof Object
    && item._isBuffer))
}

httpMessageParser._isNodeBufferSupported = function () {
  return (typeof globalThis === 'object'
    && typeof Buffer === 'function'
    && typeof Buffer.isBuffer === 'function')
}

httpMessageParser._parseHeaders = function _parseHeaders(body) {
  const headers = {}

  if (typeof body !== 'string') {
    return headers
  }

  body.split(/[\r\n]/).forEach((string) => {
    const match = string.match(/([\w-]+):\s*(.*)/)

    if (Array.isArray(match) && match.length === 3) {
      const key = match[1]
      const value = match[2]

      headers[key] = httpMessageParser._isNumeric(value) ? Number(value) : value
    }
  })

  return headers
}

httpMessageParser._requestLineRegex = /(HTTP|EVENT)\/(1\.0|1\.1|2\.0)\s+(\d+)\s+([\w\s-]+)/i
// The request-target (RFC 7230) contains no whitespace, so `\S+` is both
// correct and avoids the super-linear backtracking that `(.*)` between two
// `\s+` quantifiers would allow on hostile input.
httpMessageParser._responseLineRegex = /(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|TRACE|CONNECT)\s+(\S+)\s+HTTP\/(1\.0|1\.1|2\.0)/i
// httpMessageParser._headerNewlineRegex = /^[\r\n]+/gim;
httpMessageParser._headerNewlineRegex = /^[\r\n]+/gm
httpMessageParser._boundaryRegex = /(\n|\r\n)+--[\w-]+(\n|\r\n)+/g

httpMessageParser._createBuffer = function (data) {
  return Buffer.from(data)
}

export default httpMessageParser
