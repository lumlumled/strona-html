const test = require('node:test');
const assert = require('node:assert');
const { tagKind, muteRules, isMuted } = require('./push');

test('tagKind: prefiks tagu -> typ powiadomienia', () => {
  assert.equal(tagKind('watchdog-42'), 'watchdog');
  assert.equal(tagKind('watchdog-kom-9'), 'watchdog');
  assert.equal(tagKind('nowy-lead-48511'), 'nowy_lead');
  assert.equal(tagKind('new-lead-900'), 'nowy_lead');
  assert.equal(tagKind('feedback-reminder-7'), 'feedback');
  assert.equal(tagKind('sms-in-314'), 'sms');
  assert.equal(tagKind('sms-stracony-314'), 'sms');
  assert.equal(tagKind('wycena-submit-1868'), 'sprzedaz');
  assert.equal(tagKind('wycena-created-1868'), 'sprzedaz');
  assert.equal(tagKind('fulfillment-1868'), 'sprzedaz');
  assert.equal(tagKind('sklep-1868'), 'sprzedaz');
  assert.equal(tagKind('kom-msg-uuid'), 'wiadomosc');
  assert.equal(tagKind('push-test'), 'test');
  assert.equal(tagKind('cos-nowego'), 'inne');
  assert.equal(tagKind(null), 'inne');
});

test('isMuted domyślnie: Lorenzo ma wyciszony tylko watchdog', () => {
  const prev = process.env.PUSH_MUTE_RULES;
  delete process.env.PUSH_MUTE_RULES;
  try {
    // Watchdog — jedyny wyciszony typ.
    assert.equal(isMuted('Lorenzo', 'watchdog-42'), true);
    assert.equal(isMuted('lorenzo', 'watchdog-kom-1'), true);
    // Trzy dozwolone typy + sprzedaż nadal dochodzą.
    assert.equal(isMuted('Lorenzo', 'nowy-lead-1'), false);
    assert.equal(isMuted('Lorenzo', 'feedback-reminder-1'), false);
    assert.equal(isMuted('Lorenzo', 'sms-in-1'), false);
    assert.equal(isMuted('Lorenzo', 'wycena-created-1'), false);
    // Nieznany/nowy typ nie jest wyciszany (denylista, nie allowlista).
    assert.equal(isMuted('Lorenzo', 'cos-nowego-1'), false);
    // Inny użytkownik (admin) nie jest objęty regułą.
    assert.equal(isMuted('Antoni', 'watchdog-42'), false);
    assert.equal(isMuted('', 'watchdog-42'), false);
  } finally {
    if (prev === undefined) delete process.env.PUSH_MUTE_RULES; else process.env.PUSH_MUTE_RULES = prev;
  }
});

test('muteRules: env nadpisuje domyślne, "off" wyłącza, pusty = domyślne', () => {
  const prev = process.env.PUSH_MUTE_RULES;
  try {
    process.env.PUSH_MUTE_RULES = 'Lorenzo:watchdog,wiadomosc;Kasia:sms';
    assert.deepEqual(muteRules(), { lorenzo: ['watchdog', 'wiadomosc'], kasia: ['sms'] });
    assert.equal(isMuted('Kasia', 'sms-in-1'), true);
    assert.equal(isMuted('Lorenzo', 'kom-msg-x'), true);

    process.env.PUSH_MUTE_RULES = 'off';
    assert.deepEqual(muteRules(), {});
    assert.equal(isMuted('Lorenzo', 'watchdog-1'), false);

    process.env.PUSH_MUTE_RULES = '';
    assert.deepEqual(muteRules(), { lorenzo: ['watchdog'] });
  } finally {
    if (prev === undefined) delete process.env.PUSH_MUTE_RULES; else process.env.PUSH_MUTE_RULES = prev;
  }
});
