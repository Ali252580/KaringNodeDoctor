'use strict';

const net = require('net');
const tls = require('tls');

function buildGet(host, path) {
  return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: KaringNodeDoctor/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
}

function readHead(stream, callback) {
  let buffer = Buffer.alloc(0);
  let done = false;

  const finish = (err, head) => {
    if (done) return;
    done = true;
    stream.removeListener('data', onData);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
    callback(err, head);
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const index = buffer.indexOf('\r\n\r\n');
    if (index !== -1) finish(null, buffer.slice(0, index).toString('latin1'));
  };
  const onError = (err) => finish(err.message);
  const onClose = () => finish('connection closed');

  stream.on('data', onData);
  stream.on('error', onError);
  stream.on('close', onClose);
}

function testViaProxy(port, urlString, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let finished = false;
    let socket = null;
    let tlsSocket = null;
    let timer = null;

    const finish = (ok, extra = {}) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (tlsSocket) {
        try { tlsSocket.destroy(); } catch {}
      }
      if (socket) {
        try { socket.destroy(); } catch {}
      }
      resolve({ ok, ms: Date.now() - started, ...extra });
    };

    let target;
    try {
      target = new URL(urlString);
    } catch {
      finish(false, { error: 'آدرس تست معتبر نیست' });
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      finish(false, { error: 'آدرس تست باید http یا https باشد' });
      return;
    }

    const isTls = target.protocol === 'https:';
    const host = target.hostname;
    const destPort = Number(target.port) || (isTls ? 443 : 80);
    const reqPath = `${target.pathname || '/'}${target.search || ''}`;

    timer = setTimeout(() => finish(false, { error: 'timeout' }), timeoutMs);

    socket = net.connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);

    socket.on('error', (err) => finish(false, { error: err.code || err.message }));
    socket.on('close', () => {
      if (!finished) finish(false, { error: 'connection closed' });
    });
    socket.on('connect', () => {
      socket.write(
        `CONNECT ${host}:${destPort} HTTP/1.1\r\nHost: ${host}:${destPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`
      );
      readHead(socket, (err, head) => {
        if (finished) return;
        if (err) return finish(false, { error: err });
        const match = String(head).match(/^HTTP\/1\.[01] (\d{3})/);
        const status = match ? Number(match[1]) : 0;
        if (status !== 200) {
          return finish(false, { error: `proxy ${status || 'error'}` });
        }

        if (isTls) {
          try {
            tlsSocket = tls.connect({
              socket,
              servername: net.isIP(host) ? undefined : host,
              ALPNProtocols: ['http/1.1'],
              rejectUnauthorized: true,
            });
          } catch (tlsError) {
            return finish(false, { error: `tls ${tlsError.message}` });
          }
          tlsSocket.on('error', (tlsError) => finish(false, { error: `tls ${tlsError.message}` }));
          tlsSocket.once('secureConnect', () => {
            if (finished) return;
            tlsSocket.write(buildGet(host, reqPath));
            readHead(tlsSocket, (readError, responseHead) => {
              if (readError) return finish(false, { error: readError });
              finishFromHead(responseHead);
            });
          });
        } else {
          socket.write(buildGet(host, reqPath));
          readHead(socket, (readError, responseHead) => {
            if (readError) return finish(false, { error: readError });
            finishFromHead(responseHead);
          });
        }

        function finishFromHead(responseHead) {
          const response = String(responseHead).match(/^HTTP\/1\.[01] (\d{3})/);
          const code = response ? Number(response[1]) : 0;
          finish(code > 0 && code < 400, {
            status: code,
            error: code >= 400 ? `http ${code}` : null,
          });
        }
      });
    });
  });
}

module.exports = { testViaProxy };
