// ── Maile pipeline'u wycen (Gmail API, skrzynka kontakt@lumlum.co) ───────────
// Treści 1:1 z Make (google-email:sendAnEmail / replyToAnEmail). Tokeny
// skrzynki bierzemy z kom_mailboxes (ta sama skrzynka co Komunikator —
// odświeżanie refresh tokenem jak w apps/komunikator/server/ingest/gmail.js;
// zduplikowane ~40 linii świadomie: funkcja formularza bundluje tylko
// apps/shared/**, nie cały komunikator).
const MAILBOX = process.env.WYCENY_MAILBOX || 'kontakt@lumlum.co';

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

async function accessTokenFor(db, email) {
  const { data, error } = await db.from('kom_mailboxes').select('*').eq('active', true);
  if (error) throw error;
  const box = (data || []).find((b) => b.email.toLowerCase() === email.toLowerCase());
  if (!box || !box.tokens?.refresh_token) {
    throw new Error(`Skrzynka ${email} niepołączona (kom_mailboxes) — mail nie wyszedł`);
  }
  const stored = box.tokens;
  if (stored.access_token && stored.expires_at && new Date(stored.expires_at) > new Date()) {
    return stored.access_token;
  }
  const refreshed = await tokenRequest({
    refresh_token: stored.refresh_token,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const tokens = {
    ...stored,
    access_token: refreshed.access_token,
    expires_at: new Date(Date.now() + (refreshed.expires_in - 60) * 1000).toISOString(),
  };
  await db.from('kom_mailboxes').update({ tokens, updated_at: new Date().toISOString() }).eq('id', box.id);
  return tokens.access_token;
}

function encodeSubject(subject) {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

// MIME multipart: tekst + załączniki PDF. threadId (opcjonalny) utrzymuje
// wątek — odpowiednik replyToAnEmail z Make (faktura VAT dokleja się pod
// proformę u klienta).
async function sendMail(db, { to, subject, text, attachments = [], threadId = null }) {
  const accessToken = await accessTokenFor(db, MAILBOX);
  const boundary = `lumlum${Date.now().toString(36)}`;
  const parts = [
    `From: ${MAILBOX}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(text), 'utf8').toString('base64'),
  ];
  attachments.forEach((a) => {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      a.data.toString('base64')
    );
  });
  parts.push(`--${boundary}--`);

  const raw = Buffer.from(parts.join('\r\n'), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail send → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return { id: body.id, threadId: body.threadId };
}

const STOPKA = '\n\nPozdrawiam \nAntoni \nLumLum\nTel. 604 650 590';

// Szablony 1:1 z Make.
const MAILE = {
  codZProforma: (trackingNumber) => ({
    text: `Dzień dobry,\n\nw załączniku przesyłam fakturę proforma za zamówienie, po doręczeniu przesyłki prześlę opłaconą fakturę VAT.\n\nNumer śledzenia przesyłki InPost:\n${trackingNumber}\n\nLink do śledzenia:\nhttps://inpost.pl/sledzenie-przesylek?number=${trackingNumber}${STOPKA}`,
  }),
  przelewZProforma: (paymentLink) => ({
    text: `Dzień dobry,\n\nw załączniku przesyłam fakturę proforma za zamówienie, po doręczeniu przesyłki prześlę opłaconą fakturę VAT.\n\nMożesz wygodnie zapłacić BLIK lub przelewem dzięki szybkim płatnościom\n\nLink do szybkich płatności\n${paymentLink}${STOPKA}`,
  }),
  oplaconaVatZTrackingiem: (trackingNumber) => ({
    text: `Dzień dobry,\n\nw załączniku przesyłam opłaconą fakturę VAT.\n\nNumer śledzenia przesyłki InPost:\n${trackingNumber}\n\nLink do śledzenia:\nhttps://inpost.pl/sledzenie-przesylek?number=${trackingNumber}${STOPKA}`,
  }),
  vatPoDoreczeniu: () => ({
    text: `Dzień dobry,\n\nw załączniku przesyłam opłaconą fakturę VAT.${STOPKA}`,
  }),
};

module.exports = { sendMail, MAILE, MAILBOX };
