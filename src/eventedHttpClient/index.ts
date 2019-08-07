/**
 * The contents in this file were taken from NorthernMan54/Hap-Node-Client
 * https://github.com/NorthernMan54/Hap-Node-Client/blob/master/lib/eventedHttpClient.js
 */

import * as net from 'net';
import * as url from 'url';
import httpMessageParser from './/httpParser';

export const parseMessage = httpMessageParser;

export function createConnection(instance, pin: string, body) {
  const client = net.createConnection({
    host: instance.ipAddress,
    port: instance.port,
  });

  client.write(_buildMessage({
    method: 'PUT',
    url: 'http://' + instance.ipAddress + ':' + instance.port + '/characteristics',
    maxAttempts: 1, // (default) try 5 times
    headers: {
      'Content-Type': 'Application/json',
      'authorization': pin,
      'connection': 'keep-alive'
    },
    body: JSON.stringify(body)
  }));

  return client;
}

function _headersToString(headers) {
  let response = '';

  for (const header of Object.keys(headers)) {
    response = response + header + ': ' + headers[header] + '\r\n';
  }
  return (response);
}

function _buildMessage(request) {
  const context = url.parse(request.url);
  let message;

  message = request.method + ' ' + context.pathname;
  if (context.search) {
    message = message + context.search;
  }
  message = message + ' HTTP/1.1\r\nHost: ' + context.host + '\r\n' + _headersToString(request.headers);
  if (request.body) {
    message = message + 'Content-Length: ' + request.body.length + '\r\n\r\n' + request.body + '\r\n\r\n';
  } else {
    message = message + '\r\n\r\n';
  }
  // debug("Message ->", message);
  return (message);
}
