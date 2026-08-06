#!/usr/bin/env node
// FAZA 2 (panel Kreacje): Instagram dostaje FORMAT + OKŁADKĘ.
// Ścieżka główna (za darmo): dopasowanie każdej rolki IG do BLIŹNIAKA z TikToka
// (ta sama treść cross-postowana tego samego dnia) po dacie + długości + opisie,
// i przepisanie formatu/okładki/hooka/streszczenia twina do wiersza IG w
// marketing_video_analysis (platform='instagram', format_source='twin:<tt_id>').
// Ścieżka ogona (płatna, ~$1-3): rolki IG BEZ bliźniaka lecą przez wizję
// (yt-dlp → klatki → Opus/Sonnet) tak jak TikTok — żeby IG miał 100% formatów.
// Pamięć: project_atrybucja_organic_tresc (Faza 2).
//
// Użycie:
//   node scripts/ig-format-from-twin.js --dry-run   # sam raport dopasowań (nic nie zapisuje)
//   node scripts/ig-format-from-twin.js             # dopasowanie → zapis IG do VA + wizja na ogony
//   node scripts/ig-format-from-twin.js --no-vision # tylko dopasowanie (bez płatnej wizji)
//   node scripts/ig-format-from-twin.js --vision-limit 5   # ogranicz wizję (test kosztu)
//   node scripts/ig-format-from-twin.js --reset     # usuń wcześniej dopisane wiersze IG i policz od nowa

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const KOM = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM, 'node_modules', 'dotenv')).config({ path: path.join(KOM, '.env') });
const llm = require(path.join(KOM, 'llm.js'));
const { getClient } = require(path.join(KOM, 'supabase.js'));
const db = getClient();

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = flag('--dry-run');
const NO_VISION = flag('--no-vision');
const RESET = flag('--reset');
const VISION_LIMIT = Number(opt('--vision-limit', '0')) || 0;
// IG blokuje yt-dlp bez logowania — podaj przeglądarkę z zalogowanym IG, np.
// --cookies-from-browser chrome (lub safari/firefox). Bez tego ogony lecą przez
// klasyfikację Z OPISU (text-only), oznaczoną format_source='caption-llm'.
const COOKIES_BROWSER = opt('--cookies-from-browser', '');
const TEXT_ONLY = flag('--text-only'); // wymuś klasyfikację z opisu (pomiń pobieranie wideo)

const COVER_BUCKET = 'marketing-media';
const PY = process.env.PYTHON_BIN || 'python3';
const FRAMES_N = 6;
const FRAME_WIDTH = 480;
const DATE_WINDOW_DAYS = 3;      // szukaj bliźniaka w oknie ±3 dni
const ACCEPT_SCORE = 0.55;       // próg akceptacji dopasowania

// ── util ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, a, o = {}) {
  return new Promise((res, rej) => execFile(cmd, a, { maxBuffer: 64 * 1024 * 1024, ...o }, (e, so, se) => {
    if (e) { e.stderr = se; return rej(e); } res({ stdout: so, stderr: se });
  }));
}
const dayNum = (ts) => Math.floor(new Date(ts).getTime() / 86400000); // dzień UTC jako liczba
function normCaption(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')       // linki
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')     // emoji/interpunkcja → spacja (zostaw litery+cyfry, w tym PL)
    .replace(/\s+/g, ' ')
    .trim();
}
// Dice na 3-gramach znakowych — odporny na drobne różnice w opisie.
function trigrams(s) {
  const t = ` ${s} `; const g = new Set();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

async function loadFormats() {
  const { data, error } = await db.from('marketing_content_formats').select('slug,name,description,cues').eq('active', true).order('sort_order');
  if (error) { console.warn(`[formaty] nie wczytano: ${error.message}`); return []; }
  return data || [];
}

// ── DOPASOWANIE IG ↔ TikTok ──────────────────────────────────────────────────
function scoreCandidate(ig, tt) {
  const dd = Math.abs(dayNum(ig.published_at) - dayNum(tt.published_at));
  if (dd > DATE_WINDOW_DAYS) return null;
  const dScore = 1 - dd / (DATE_WINDOW_DAYS + 1);                 // 1.0 same day → ~0.25 przy 3 dniach
  const cSim = (ig._tri && tt._tri) ? dice(ig._tri, tt._tri) : 0; // podobieństwo opisu
  const durScore = (ig.duration_s && tt.duration_s)
    ? Math.max(0, 1 - Math.abs(ig.duration_s - tt.duration_s) / Math.max(ig.duration_s, tt.duration_s, 5)) : 0;
  const hasCap = ig._tri && tt._tri && ig._tri.size > 3 && tt._tri.size > 3;
  // Wagi: opis najważniejszy gdy jest; bez opisu podpieramy się datą+długością.
  const score = hasCap ? (0.55 * cSim + 0.28 * dScore + 0.17 * durScore)
                       : (0.62 * dScore + 0.38 * durScore);
  return { dd, dScore, cSim, durScore, hasCap, score };
}
function bestTwin(ig, ttRows) {
  let best = null;
  for (const tt of ttRows) {
    const s = scoreCandidate(ig, tt);
    if (!s) continue;
    if (!best || s.score > best.s.score) best = { tt, s };
  }
  if (!best) return null;
  const { s } = best;
  // Akceptacja: ten sam dzień + jakikolwiek sensowny sygnał, ALBO mocny opis, ALBO wysoki łączny score.
  const accept = (s.dd === 0 && (s.cSim >= 0.3 || s.durScore >= 0.6 || !s.hasCap))
    || (s.cSim >= 0.6) || (s.score >= ACCEPT_SCORE);
  return accept ? best : { tt: best.tt, s, rejected: true };
}

// ── WIZJA (ogony bez bliźniaka) — jak tiktok-video-base.js, uogólnione na IG ──
let FFMPEG = 'ffmpeg';
function resolveFfmpeg() {
  try { const p = execFileSync(PY, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p; } catch (_) {}
  return 'ffmpeg';
}
async function download(url, wd) {
  const out = path.join(wd, 'video.mp4');
  const cookieArgs = COOKIES_BROWSER ? ['--cookies-from-browser', COOKIES_BROWSER] : [];
  await sh(PY, ['-m', 'yt_dlp', '-f', 'b', '--no-playlist', '--no-warnings', ...cookieArgs, '--ffmpeg-location', FFMPEG, '-o', out, url]);
  if (fs.existsSync(out)) return out;
  const f = fs.readdirSync(wd).find((x) => /^video\./.test(x));
  if (!f) throw new Error('pobranie nie dało pliku'); return path.join(wd, f);
}
async function durationOf(file) {
  try { await sh(FFMPEG, ['-i', file]); } catch (e) {
    const m = String(e.stderr || e.message).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }
  return 0;
}
async function extractAudio(file, wd) {
  const mp3 = path.join(wd, 'a.mp3');
  await sh(FFMPEG, ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', mp3]); return mp3;
}
async function extractFrames(file, wd, dur) {
  const frames = []; const d = dur > 0 ? dur : 20;
  for (let i = 0; i < FRAMES_N; i++) {
    const t = (d * (i + 0.5)) / FRAMES_N; const out = path.join(wd, `f${i}.jpg`);
    await sh(FFMPEG, ['-y', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-1`, '-q:v', '4', out]);
    if (fs.existsSync(out)) frames.push({ t: Number(t.toFixed(2)), path: out });
  }
  return frames;
}
const VISUAL_SYSTEM = `Jestes analitykiem kreacji video dla marki LumLum (cyfrowe oswietlenie LED, rolki TikTok/Reels po polsku).
Dostajesz KLATKI z jednej rolki (po kolei w czasie) + opis. Opisz CO SIE NA NIEJ DZIEJE tak, zeby dalo sie ja przypisac do formatu tresci.
Zwroc WYLACZNIE czysty JSON (bez markdown) w schemacie:
{
  "summary": "1-2 zdania co to za rolka",
  "setting": "salon|sypialnia|kuchnia|korytarz|schody|lazienka|zewnetrze/ogrod|studio/tlo|inne",
  "person_on_screen": true,
  "person_action": "gada do kamery|trzyma produkt|montaz/instalacja|pokazuje efekt|brak|inne",
  "product_in_hand": {"present": false, "what": "tasma led|szpula tasmy|sterownik|zasilacz|pilot|czujnik|inne|"},
  "overlay_graphic": {"present": false, "desc": "np. wklejka/wizualizacja/render efektu"},
  "drawn_annotation": {"present": false, "desc": "np. strzalka, podkreslenie"},
  "before_after": false,
  "screen_recording": false,
  "effect_shown": false,
  "shot_type": "gadajaca glowa|produkt w rekach|wnetrze/efekt|nagranie ekranu|mix",
  "on_screen_text": ["napisy widoczne na klatkach, doslownie"],
  "beats": ["kolejne sceny/ujecia po kolei, krotko"],
  "format_guess": "krotka propozycja nazwy formatu na podstawie tego co widac",
  "format": "slug formatu z listy ktora dostaniesz nizej, albo 'inne'",
  "format_conf": 0.0
}`;
function formatsBlock(formats) {
  return formats.map((f, i) => `${i + 1}. ${f.slug} — ${f.name}: ${f.description}${f.cues ? ` [sygnaly: ${f.cues}]` : ''}`).join('\n');
}
async function analyzeVisual(frames, caption, formats) {
  const content = frames.map((f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f.path).toString('base64') } }));
  content.push({ type: 'text', text: `Klatki po kolei (t=${frames.map((f) => f.t).join('s, ')}s).\nOPIS ROLKI: ${caption || '(brak)'}\nZwroc sam JSON wg schematu.` });
  const system = VISUAL_SYSTEM + (formats && formats.length
    ? `\n\nLISTA FORMATOW (przypisz rolke do DOKLADNIE JEDNEGO — pole "format" = slug, "format_conf" = 0-1; jesli zaden nie pasuje: "format":"inne"):\n${formatsBlock(formats)}` : '');
  const { text, model } = await llm.complete({ task: 'media', system, messages: [{ role: 'user', content }], maxTokens: 1600 });
  let json;
  try { const m = text.match(/\{[\s\S]*\}/); json = JSON.parse(m ? m[0] : text); } catch (e) { json = { _parse_error: e.message, _raw: text.slice(0, 500) }; }
  return { visual: json, model };
}
function hookOf(t) { if (!t) return null; const s = t.replace(/\s+/g, ' ').trim(); const first = s.split(/(?<=[.!?])\s/)[0]; return (first || s).slice(0, 200); }
let coverBucketReady = false;
async function uploadCover(frames, id) {
  const frame = frames[Math.min(1, frames.length - 1)];
  if (!frame || !fs.existsSync(frame.path)) return { cover_path: null, cover_url: null };
  try {
    if (!coverBucketReady) {
      const { error } = await db.storage.createBucket(COVER_BUCKET, { public: true });
      if (error && !/already exists|duplicate/i.test(error.message)) throw error; coverBucketReady = true;
    }
    const cover_path = `instagram/${id}.jpg`;
    const { error: upErr } = await db.storage.from(COVER_BUCKET).upload(cover_path, fs.readFileSync(frame.path), { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const { data } = db.storage.from(COVER_BUCKET).getPublicUrl(cover_path);
    return { cover_path, cover_url: data?.publicUrl || null };
  } catch (e) { console.warn(`    [cover] ${id}: ${e.message}`); return { cover_path: null, cover_url: null }; }
}
// Klasyfikacja Z OPISU (bez wideo) — fallback gdy IG blokuje pobranie. Słabsza
// niż wizja (opis nie zdradza ujęcia), więc oznaczamy 'caption-llm' i format_conf
// przycinamy w górę do 0.5, żeby nie udawać pewności obrazu.
const CAPTION_SYSTEM = `Jestes analitykiem kreacji video dla marki LumLum (cyfrowe oswietlenie LED, rolki Instagram/TikTok po polsku).
Masz TYLKO OPIS rolki (bez klatek). Zgadnij najbardziej prawdopodobny FORMAT tresci z listy. Jesli opis nie wystarcza — zwroc "inne".
Zwroc WYLACZNIE czysty JSON: {"summary":"1 zdanie o czym rolka","format":"slug z listy albo inne","format_conf":0.0}`;
async function classifyFromCaption(ig, formats) {
  const system = CAPTION_SYSTEM + `\n\nLISTA FORMATOW:\n${formatsBlock(formats)}`;
  const { text, model } = await llm.complete({ task: 'classify', system, messages: [{ role: 'user', content: `OPIS ROLKI: ${ig.title || '(brak opisu)'}\nZwroc sam JSON.` }], maxTokens: 300 });
  let json; try { const m = text.match(/\{[\s\S]*\}/); json = JSON.parse(m ? m[0] : text); } catch (_) { json = {}; }
  const known = new Set((formats || []).map((f) => f.slug));
  const formatSlug = known.has(json.format) ? json.format : null;
  return {
    platform: 'instagram', video_id: ig.post_id, url: ig.url, caption: ig.title || null,
    published_at: ig.published_at, duration_s: ig.duration_s || null,
    visual: json.summary ? { summary: json.summary, _source: 'caption-only' } : null,
    hook: null, cover_path: null, cover_url: null,
    format: formatSlug, format_conf: formatSlug ? Math.min(0.5, Number(json.format_conf) || 0.4) : null,
    format_source: formatSlug ? 'caption-llm' : null, model_visual: model || null,
    status: 'done', error: null, updated_at: new Date().toISOString(),
  };
}
async function visionRow(ig, formats) {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), `ig_${ig.post_id}_`));
  try {
    const file = await download(ig.url, wd);
    const duration = await durationOf(file);
    const mp3P = extractAudio(file, wd).catch((e) => { console.warn(`    [audio] ${ig.post_id}: bez transkrypcji (${String(e.message).slice(0, 60)})`); return null; });
    const [mp3, frames] = await Promise.all([mp3P, extractFrames(file, wd, duration)]);
    const [tr, vis] = await Promise.all([
      mp3 ? llm.transcribe({ buffer: fs.readFileSync(mp3), filename: 'a.mp3', mime: 'audio/mpeg', language: 'pl' }) : Promise.resolve({ text: '', model: null }),
      analyzeVisual(frames, ig.title, formats),
    ]);
    const v = (vis.visual && typeof vis.visual === 'object') ? vis.visual : {};
    const known = new Set((formats || []).map((f) => f.slug));
    const formatSlug = known.has(v.format) ? v.format : null;
    const cover = await uploadCover(frames, ig.post_id);
    return {
      platform: 'instagram', video_id: ig.post_id, url: ig.url, caption: ig.title || null,
      published_at: ig.published_at, duration_s: Math.round(duration) || ig.duration_s || null,
      transcript: tr.text, transcript_src: 'whisper', hook: hookOf(tr.text), model_transcribe: tr.model,
      visual: vis.visual, frames_n: frames.length, model_visual: vis.model,
      cover_path: cover.cover_path, cover_url: cover.cover_url,
      format: formatSlug, format_conf: formatSlug ? (Number(v.format_conf) || null) : null,
      format_source: formatSlug ? 'auto' : null,
      status: 'done', error: null, updated_at: new Date().toISOString(),
    };
  } finally { try { fs.rmSync(wd, { recursive: true, force: true }); } catch (_) {} }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (RESET && !DRY) {
    const { error } = await db.from('marketing_video_analysis').delete().eq('platform', 'instagram');
    if (error) throw error;
    console.log('[reset] usunięto wcześniejsze wiersze IG z marketing_video_analysis.');
  }

  const [igR, ttR, fmtR] = await Promise.all([
    db.from('marketing_organic_posts').select('post_id,url,title,published_at,duration_s,views').eq('platform', 'instagram'),
    db.from('marketing_video_analysis').select('video_id,format,format_conf,cover_url,cover_path,url,hook,caption,duration_s,published_at,visual,transcript').eq('platform', 'tiktok').eq('status', 'done'),
    db.from('marketing_content_formats').select('slug,name').eq('active', true),
  ]);
  if (igR.error) throw igR.error;
  if (ttR.error) throw ttR.error;
  const igPosts = (igR.data || []).filter((p) => p.published_at && p.url);
  const ttRows = (ttR.data || []).filter((t) => t.published_at).map((t) => ({ ...t, _tri: trigrams(normCaption(t.caption)) }));
  const fmtName = new Map((fmtR.data || []).map((f) => [f.slug, f.name]));
  igPosts.forEach((p) => { p._tri = trigrams(normCaption(p.title)); });
  console.log(`IG postów: ${igPosts.length} | TikTok (done): ${ttRows.length}`);

  const matched = [], unmatched = [];
  for (const ig of igPosts) {
    const b = bestTwin(ig, ttRows);
    if (b && !b.rejected && b.tt.format) matched.push({ ig, tt: b.tt, s: b.s });
    else unmatched.push({ ig, near: b || null });
  }
  const matchedNoFmt = [];
  for (const ig of igPosts) {
    const b = bestTwin(ig, ttRows);
    if (b && !b.rejected && !b.tt.format) matchedNoFmt.push({ ig, tt: b.tt, s: b.s }); // twin istnieje ale sam bez formatu
  }

  console.log(`\n=== DOPASOWANIE ===`);
  console.log(`dopasowane do bliźniaka Z FORMATEM: ${matched.length}`);
  console.log(`dopasowane, ale bliźniak bez formatu: ${matchedNoFmt.length}`);
  console.log(`bez bliźniaka (kandydaci do wizji): ${unmatched.length}`);
  const byFmt = {}; matched.forEach((m) => { const n = fmtName.get(m.tt.format) || m.tt.format; byFmt[n] = (byFmt[n] || 0) + 1; });
  console.log('rozkład formatów (z bliźniaka):', JSON.stringify(byFmt));
  console.log('\nPróbka dopasowań:');
  matched.slice(0, 6).forEach((m) => console.log(`  IG ${m.ig.post_id} "${(m.ig.title || '').slice(0, 34)}" → TT ${m.tt.video_id} [${fmtName.get(m.tt.format) || m.tt.format}] score=${m.s.score.toFixed(2)} dd=${m.s.dd} cSim=${m.s.cSim.toFixed(2)} dur=${m.s.durScore.toFixed(2)}`));
  console.log('\nPróbka BEZ bliźniaka:');
  unmatched.slice(0, 12).forEach((u) => console.log(`  IG ${u.ig.post_id} "${(u.ig.title || '').slice(0, 40)}" ${u.ig.published_at?.slice(0, 10)} dur=${u.ig.duration_s ?? '?'} ${u.near ? `(najbliżej TT ${u.near.tt.video_id} score=${u.near.s.score.toFixed(2)} dd=${u.near.s.dd})` : '(brak kandydata w oknie)'}`));

  if (DRY) { console.log('\n[dry-run] nic nie zapisano.'); return; }

  // ── ZAPIS dopasowanych (przepisanie twina) ──
  const rows = matched.map(({ ig, tt, s }) => ({
    platform: 'instagram', video_id: ig.post_id, url: ig.url, caption: ig.title || null,
    published_at: ig.published_at, duration_s: ig.duration_s || tt.duration_s || null,
    transcript: tt.transcript || null, transcript_src: tt.transcript ? 'twin' : null,
    hook: tt.hook || null,
    visual: tt.visual || null,
    cover_path: tt.cover_path || null, cover_url: tt.cover_url || null,
    format: tt.format, format_conf: tt.format_conf ?? null,
    format_source: `twin:${tt.video_id}`,
    status: 'done', error: null,
    // ślad dopasowania w kolumnie error? nie — trzymamy provenance w format_source. Meta w model_visual:
    model_visual: `twin(score=${s.score.toFixed(2)},dd=${s.dd},cSim=${s.cSim.toFixed(2)})`,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await db.from('marketing_video_analysis').upsert(rows, { onConflict: 'platform,video_id' });
    if (error) throw new Error(`upsert IG twins: ${error.message}`);
    console.log(`\n[db] zapisano ${rows.length} wierszy IG (format z bliźniaka).`);
  }

  // ── OGONY bez bliźniaka: wizja (jeśli cookies) → fallback z opisu ──
  if (NO_VISION) { console.log(`[ogony] pominięte (--no-vision). ${unmatched.length} rolek IG bez formatu.`); return; }
  if (!unmatched.length) { console.log('[ogony] brak rolek bez bliźniaka — nie ma czego dorabiać.'); return; }
  FFMPEG = resolveFfmpeg();
  const formats = await loadFormats();
  let todo = unmatched.map((u) => u.ig);
  if (VISION_LIMIT) todo = todo.slice(0, VISION_LIMIT);
  const tryVision = !TEXT_ONLY; // gdy brak cookies, pobranie IG i tak padnie → fallback z opisu
  console.log(`\n=== OGONY: ${todo.length} rolek IG bez bliźniaka (wizja=${tryVision ? (COOKIES_BROWSER || 'bez cookies → padnie do opisu') : 'off'}) ===`);
  let vis = 0, cap = 0, err = 0;
  for (let i = 0; i < todo.length; i++) {
    const ig = todo[i];
    process.stdout.write(`  [${i + 1}/${todo.length}] IG ${ig.post_id} … `);
    let row = null, via = '';
    if (tryVision) {
      try { row = await visionRow(ig, formats); via = 'wizja'; }
      catch (e) { process.stdout.write(`(wizja padła: ${String(e.message).slice(0, 50)}) → opis … `); }
    }
    if (!row) {
      try { row = await classifyFromCaption(ig, formats); via = 'opis'; }
      catch (e) { console.log(`BŁĄD: ${e.message}`); err++; await sleep(300); continue; }
    }
    try {
      const { error } = await db.from('marketing_video_analysis').upsert([row], { onConflict: 'platform,video_id' });
      if (error) throw error;
      console.log(`ok via ${via} [${row.format || 'inne'}${row.format_source ? ' · ' + row.format_source : ''}]`);
      if (via === 'wizja') vis++; else cap++;
    } catch (e) { console.log(`ZAPIS BŁĄD: ${e.message}`); err++; }
    await sleep(400);
  }
  console.log(`\n=== OGONY DONE: wizja ${vis}, z opisu ${cap}, błędy ${err}. ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
