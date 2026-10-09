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
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      const complete = lines.slice(0, -1);
      if (!complete.length) return;
      const last = complete[complete.length - 1];
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData);
        buffer = lines[lines.length - 1];
        resolve({ code: Number(last.slice(0, 3)), text: complete.join('\n') });
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
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

export async function smtpSend({ from, to, subject, text }, smtpUrl) {
  const url = new URL(smtpUrl);
  const implicitTls = url.protocol === 'smtps:';
  const port = Number(url.port || (implicitTls ? 465 : 587));
  const host = url.hostname;
  const user = decodeURIComponent(url.username || '');
  const pass = decodeURIComponent(url.password || '');
  const socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(15000);
  try {
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
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
      });
      return await smtpAfterTls(secure, { from, to, subject, text, user, pass });
    }
    return await smtpAfterTls(socket, { from, to, subject, text, user, pass });
  } finally {
    socket.end();
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
    String(text || '').replace(/^\./gm, '..'),
    '.'
  ].join('\r\n');
  socket.write(`${body}\r\n`);
  await expect(socket, 250);
  writeLine(socket, 'QUIT');
  return { status: 'sent', provider: 'smtp' };
}
