/**
 * Minimal SMTP sender for a customer relay (MAIL_SMTP_URL).
 * smtp:// uses STARTTLS on the implicit plain port. smtps:// is TLS from the start.
 * Tests inject `transport` and never open a socket.
 */

import net from 'node:net';
import tls from 'node:tls';

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      const complete = lines.slice(0, -1);
      if (!complete.length) return;
      const last = complete[complete.length - 1];
      if (/^\d{3} /.test(last)) {
        cleanup();
        buffer = lines[lines.length - 1];
        resolve({ code: Number(last.slice(0, 3)), text: complete.join('\n') });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      const error = new Error('SMTP connection closed');
      error.code = 'SMTP_CLOSED';
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function writeLine(socket, line) {
  socket.write(`${line}\r\n`);
}

async function expect(socket, codes) {
  const reply = await readReply(socket);
  const allowed = Array.isArray(codes) ? codes : [codes];
  if (!allowed.includes(reply.code)) {
    throw new Error(`SMTP ${reply.code}`);
  }
  return reply;
}

export const SMTP_TIMEOUT_MS = 8000;

/** CRLF body with leading-dot stuffing. SMTP DATA requires both. */
export function smtpTextBody(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function ignoreLate(promise) {
  promise.catch(() => {});
  return promise;
}

export async function smtpSend({ from, to, subject, text }, smtpUrl, options = {}) {
  const url = new URL(smtpUrl);
  const implicitTls = url.protocol === 'smtps:';
  const port = Number(url.port || (implicitTls ? 465 : 587));
  const host = url.hostname;
  const user = decodeURIComponent(url.username || '');
  const pass = decodeURIComponent(url.password || '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : SMTP_TIMEOUT_MS;
  const socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      timedOut = true;
      const error = new Error('SMTP timeout');
      error.code = 'SMTP_TIMEOUT';
      socket.destroy();
      reject(error);
    });
  });
  const conversation = (async () => {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('connect', () => {
        if (!implicitTls) resolve();
      });
      socket.once('error', reject);
    });
    await expect(socket, 220);
    writeLine(socket, `EHLO procureflow`);
    await expect(socket, 250);
    if (!implicitTls) {
      writeLine(socket, 'STARTTLS');
      await expect(socket, 220);
      const secure = tls.connect({ socket, servername: host });
      secure.setTimeout(timeoutMs);
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
        secure.once('timeout', () => {
          const error = new Error('SMTP timeout');
          error.code = 'SMTP_TIMEOUT';
          secure.destroy();
          reject(error);
        });
      });
      return smtpAfterTls(secure, { from, to, subject, text, user, pass });
    }
    return smtpAfterTls(socket, { from, to, subject, text, user, pass });
  })();
  try {
    return await Promise.race([ignoreLate(conversation), ignoreLate(timeout)]);
  } finally {
    socket.setTimeout(0);
    if (timedOut || !socket.destroyed) socket.destroy();
  }
}

async function smtpAfterTls(socket, { from, to, subject, text, user, pass }) {
  writeLine(socket, 'EHLO procureflow');
  await expect(socket, 250);
  if (user) {
    writeLine(socket, 'AUTH LOGIN');
    await expect(socket, 334);
    writeLine(socket, Buffer.from(user).toString('base64'));
    await expect(socket, 334);
    writeLine(socket, Buffer.from(pass).toString('base64'));
    await expect(socket, 235);
  }
  writeLine(socket, `MAIL FROM:<${from}>`);
  await expect(socket, 250);
  writeLine(socket, `RCPT TO:<${to}>`);
  await expect(socket, [250, 251]);
  writeLine(socket, 'DATA');
  await expect(socket, 354);
  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    smtpTextBody(text),
    '.'
  ].join('\r\n');
  socket.write(`${body}\r\n`);
  await expect(socket, 250);
  writeLine(socket, 'QUIT');
  return { status: 'sent', provider: 'smtp' };
}
