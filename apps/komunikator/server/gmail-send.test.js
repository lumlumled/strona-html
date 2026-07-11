// Testy wysyłki odpowiedzi przez Gmail API (node --test).
// Krytyczne: odpowiedź musi wpiąć się w istniejący wątek (threadId +
// In-Reply-To/References) i poprawnie kodować polskie znaki (RFC 2047 w
// temacie, base64 w treści) — inaczej klient dostaje krzaki albo nowy mail.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, opts });
  if (u.includes('format=metadata')) {
    return {
      ok: true,
      text: async () => JSON.stringify({
        payload: {
          headers: [
            { name: 'Message-ID', value: '<klient-123@mail.gmail.com>' },
            { name: 'References', value: '<poczatek-watku@mail.gmail.com>' },
          ],
        },
      }),
    };
  }
  if (u.endsWith('/messages/send')) {
    return { ok: true, text: async () => JSON.stringify({ id: 'sent-1', threadId: 'th-1' }) };
  }
  throw new Error(`Nieoczekiwany fetch: ${u}`);
};

const gmail = require('./ingest/gmail');

// kom_settings z ważnym access_tokenem — ensureAccessToken nie robi refreshu.
const db = {
  from: () => ({
    select: () => ({
      eq: () => ({
        limit: async () => ({
          data: [{
            value: {
              refresh_token: 'r',
              access_token: 'a',
              email: 'kontakt@lumlum.co',
              expires_at: new Date(Date.now() + 3600e3).toISOString(),
            },
          }],
          error: null,
        }),
      }),
    }),
  }),
};

function decodeRaw(raw) {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

test('odpowiedź idzie w wątku Gmaila z poprawnym MIME i polskimi znakami', async () => {
  calls.length = 0;
  const res = await gmail.sendReply(db, {
    to: 'jan@klient.pl',
    subject: 'Wycena oświetlenia schodów',
    text: 'Dzień dobry, całość wyjdzie 2999 zł.',
    gmailThreadId: 'th-1',
    lastGmailMessageId: 'msg-klienta',
  });
  assert.equal(res.id, 'sent-1');

  const sendCall = calls.find((c) => c.url.endsWith('/messages/send'));
  assert.ok(sendCall, 'brak wywołania messages.send');
  const body = JSON.parse(sendCall.opts.body);
  assert.equal(body.threadId, 'th-1', 'wysyłka musi wskazać wątek Gmaila');

  const mime = decodeRaw(body.raw);
  assert.ok(mime.includes('To: jan@klient.pl'));
  assert.ok(mime.includes('From: kontakt@lumlum.co'));
  assert.ok(mime.includes('Subject: =?UTF-8?B?'), 'temat z polskimi znakami musi być zakodowany (RFC 2047)');
  assert.ok(mime.includes('In-Reply-To: <klient-123@mail.gmail.com>'));
  assert.ok(
    mime.includes('References: <poczatek-watku@mail.gmail.com> <klient-123@mail.gmail.com>'),
    'References = stare referencje + Message-ID ostatniego maila'
  );
  const bodyB64 = mime.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(bodyB64, 'base64').toString('utf8'), 'Dzień dobry, całość wyjdzie 2999 zł.');
});

test('temat już z "Re:" nie jest dublowany, ASCII bez kodowania', async () => {
  calls.length = 0;
  await gmail.sendReply(db, {
    to: 'jan@klient.pl',
    subject: 'Re: Zapytanie LED',
    text: 'Ok',
    gmailThreadId: 'th-1',
    lastGmailMessageId: null,
  });
  const sendCall = calls.find((c) => c.url.endsWith('/messages/send'));
  const mime = decodeRaw(JSON.parse(sendCall.opts.body).raw);
  assert.ok(mime.includes('Subject: Re: Zapytanie LED'));
  assert.ok(!mime.includes('Re: Re:'), 'podwójne Re: w temacie');
  assert.ok(!mime.includes('In-Reply-To:'), 'bez ID ostatniego maila nie zgadujemy nagłówków');
});
