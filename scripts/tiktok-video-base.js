#!/usr/bin/env node
// Baza filmu TikTok: enumeracja katalogu @lumlum.led (Apify) → per rolka
// pobranie (yt-dlp) → transkrypcja PL (Whisper) + klatki (ffmpeg) → analiza
// wizualna Opus 4.8 → zapis do marketing_video_analysis (+ metryki do
// marketing_organic_posts). Fundament atrybucji "który FORMAT sprzedaje".
// Pamięć: project_baza_filmu_tiktok / project_atrybucja_organic_tresc.
//
// Zależności (maszyna Antoniego, bez brew):
//   python3 -m yt_dlp            (pip install yt-dlp)
//   ffmpeg ze statycznego imageio-ffmpeg (pip install imageio-ffmpeg)
//   env + llm.js + supabase.js z apps/komunikator/server
//
// Użycie:
//   node scripts/tiktok-video-base.js --enumerate-only   # sama lista (tanio) — policz rolki
//   node scripts/tiktok-video-base.js --limit 5          # przetwórz 5 (test kosztu)
//   node scripts/tiktok-video-base.js                    # pełny przelot (ZJADA KREDYTY)
//   node scripts/tiktok-video-base.js --reprocess        # także status='done'

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const KOM = path.join(__dirname, '..', 'apps', 'komunikator', 'server');
require(path.join(KOM, 'node_modules', 'dotenv')).config({ path: path.join(KOM, '.env') });
const llm = require(path.join(KOM, 'llm.js'));
const { getClient } = require(path.join(KOM, 'supabase.js'));
const db = getClient();

const PROFILE = (process.env.TIKTOK_PROFILE || 'lumlum.led').replace(/^@/, '');
const APIFY_API = 'https://api.apify.com';
const LIST_ACTOR = process.env.APIFY_TIKTOK_LIST_ACTOR || 'clockworks~tiktok-scraper';
const FRAMES_N = 6;
const FRAME_WIDTH = 480;
const COVER_BUCKET = 'marketing-media'; // publiczny bucket na okladki rolek (miniatury do panelu)
const PY = process.env.PYTHON_BIN || 'python3';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ENUMERATE_ONLY = flag('--enumerate-only');
const NO_ENUMERATE = flag('--no-enumerate'); // pomija re-listing przez Apify; przetwarza juz-zapisane wiersze (gdy saldo Apify wyczerpane)
const REPROCESS = flag('--reprocess');
const LIMIT = Number(opt('--limit', '0')) || 0;
const CLASSIFY_URL = opt('--classify-url', '');

let FFMPEG = 'ffmpeg';
function resolveFfmpeg() {
  try {
    const p = execFileSync(PY, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return 'ffmpeg';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, a, o = {}) {
  return new Promise((res, rej) => execFile(cmd, a, { maxBuffer: 64 * 1024 * 1024, ...o }, (e, so, se) => {
    if (e) { e.stderr = se; return rej(e); } res({ stdout: so, stderr: se });
  }));
}

// ── Apify enumeracja ────────────────────────────────────────────────────────
async function apify(method, pathname, body) {
  const url = `${APIFY_API}${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(process.env.APIFY_TOKEN || '')}`;
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Apify ${method} ${pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
}
function pick(o, ...k) { for (const key of k) { const v = o?.[key]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; }

async function enumerateProfile() {
  console.log(`[apify] start listingu @${PROFILE} (cała historia)…`);
  const { data: run } = await apify('POST', `/v2/acts/${LIST_ACTOR}/runs`, {
    profiles: [PROFILE], resultsPerPage: 1000,
    shouldDownloadVideos: false, shouldDownloadCovers: false,
    shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false,
  });
  let status = run.status, datasetId = run.defaultDatasetId, tries = 0;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status) && tries < 180) {
    await sleep(5000); tries += 1;
    const { data: r } = await apify('GET', `/v2/actor-runs/${run.id}`);
    status = r.status; datasetId = r.defaultDatasetId;
    if (tries % 6 === 0) console.log(`[apify] …${status} (${tries * 5}s)`);
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ${status}`);
  const items = await apify('GET', `/v2/datasets/${datasetId}/items?clean=true&limit=5000`);
  console.log(`[apify] pobrano ${Array.isArray(items) ? items.length : 0} pozycji.`);
  return Array.isArray(items) ? items : [];
}

function mapItem(item) {
  const videoId = pick(item, 'id', 'videoId');
  return {
    videoId,
    url: pick(item, 'webVideoUrl', 'videoUrl') || (videoId ? `https://www.tiktok.com/@${PROFILE}/video/${videoId}` : ''),
    caption: pick(item, 'text', 'desc'),
    publishedAt: pick(item, 'createTimeISO') || null,
    plays: Number(item.playCount ?? 0), likes: Number(item.diggCount ?? 0),
    comments: Number(item.commentCount ?? 0), shares: Number(item.shareCount ?? 0),
    saves: Number(item.collectCount ?? 0),
    duration: Number(item.videoMeta?.duration ?? item.duration ?? 0) || null,
  };
}

async function upsertEnumerated(items) {
  const mapped = items.map(mapItem).filter((v) => v.videoId);
  if (!mapped.length) return mapped;
  // metryki → marketing_organic_posts (pełny katalog TikToka, lepszy niż CSV top-16)
  const { error: e1 } = await db.from('marketing_organic_posts').upsert(mapped.map((v) => ({
    platform: 'tiktok', post_id: v.videoId, account: PROFILE, url: v.url, title: v.caption || null,
    published_at: v.publishedAt, duration_s: v.duration, views: v.plays, likes: v.likes,
    comments: v.comments, shares: v.shares, saves: v.saves, updated_at: new Date().toISOString(),
  })), { onConflict: 'platform,post_id' });
  if (e1) throw new Error(`organic_posts upsert: ${e1.message}`);
  // wiersze bazy filmu — nie cofamy statusu już przeanalizowanych
  const { data: existingRows } = await db.from('marketing_video_analysis').select('video_id,status').eq('platform', 'tiktok');
  const statusMap = new Map((existingRows || []).map((r) => [r.video_id, r.status]));
  const vaRows = mapped.map((v) => {
    const prev = statusMap.get(v.videoId);
    return {
      platform: 'tiktok', video_id: v.videoId, url: v.url, caption: v.caption || null,
      published_at: v.publishedAt, duration_s: v.duration,
      status: prev && prev !== 'pending' ? prev : 'enumerated',
      updated_at: new Date().toISOString(),
    };
  });
  const { error: e2 } = await db.from('marketing_video_analysis').upsert(vaRows, { onConflict: 'platform,video_id' });
  if (e2) throw new Error(`video_analysis upsert: ${e2.message}`);
  console.log(`[db] zapisano/zaktualizowano ${mapped.length} rolek.`);
  return mapped;
}

// ── Przetwarzanie pojedynczej rolki (łańcuch sprawdzony w scratchpad/test.js) ─
async function download(url, wd) {
  const out = path.join(wd, 'video.mp4');
  await sh(PY, ['-m', 'yt_dlp', '-f', 'b', '--no-playlist', '--no-warnings', '--ffmpeg-location', FFMPEG, '-o', out, url]);
  if (fs.existsSync(out)) return out;
  const f = fs.readdirSync(wd).find((x) => /^video\./.test(x));
  if (!f) throw new Error('pobranie nie dało pliku');
  return path.join(wd, f);
}
async function durationOf(file) {
  try { await sh(FFMPEG, ['-i', file]); } catch (e) {
    const m = String(e.stderr || e.message).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  return 0;
}
async function extractAudio(file, wd) {
  const mp3 = path.join(wd, 'a.mp3');
  await sh(FFMPEG, ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', mp3]);
  return mp3;
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

async function loadFormats() {
  const { data, error } = await db.from('marketing_content_formats').select('slug,name,description,cues').eq('active', true).order('sort_order');
  if (error) { console.warn(`[formaty] nie wczytano: ${error.message}`); return []; }
  return data || [];
}
function formatsBlock(formats) {
  return formats.map((f, i) => `${i + 1}. ${f.slug} — ${f.name}: ${f.description}${f.cues ? ` [sygnaly: ${f.cues}]` : ''}`).join('\n');
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

async function analyzeVisual(frames, caption, formats) {
  const content = frames.map((f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f.path).toString('base64') } }));
  content.push({ type: 'text', text: `Klatki po kolei (t=${frames.map((f) => f.t).join('s, ')}s).\nOPIS ROLKI: ${caption || '(brak)'}\nZwroc sam JSON wg schematu.` });
  const system = VISUAL_SYSTEM + (formats && formats.length
    ? `\n\nLISTA FORMATOW (przypisz rolke do DOKLADNIE JEDNEGO — pole "format" = slug, "format_conf" = 0-1; jesli zaden nie pasuje: "format":"inne"):\n${formatsBlock(formats)}`
    : '');
  const { text, model } = await llm.complete({ task: 'media', system, messages: [{ role: 'user', content }], maxTokens: 1600 });
  let json;
  try { const m = text.match(/\{[\s\S]*\}/); json = JSON.parse(m ? m[0] : text); } catch (e) { json = { _parse_error: e.message, _raw: text.slice(0, 500) }; }
  return { visual: json, model };
}
function hookOf(t) { if (!t) return null; const s = t.replace(/\s+/g, ' ').trim(); const first = s.split(/(?<=[.!?])\s/)[0]; return (first || s).slice(0, 200); }

// Okladka: wrzuca wybrany kadr do publicznego bucketa i zwraca {cover_path, cover_url}.
// Blad uploadu NIE przerywa wiersza (transkrypcja+wizja sa cenniejsze) — logujemy i lecimy dalej.
let coverBucketReady = false;
async function uploadCover(frames, videoId) {
  const frame = frames[Math.min(1, frames.length - 1)]; // 2. kadr — reprezentatywny, rzadko czarny
  if (!frame || !fs.existsSync(frame.path)) return { cover_path: null, cover_url: null };
  try {
    if (!coverBucketReady) {
      const { error } = await db.storage.createBucket(COVER_BUCKET, { public: true });
      if (error && !/already exists|duplicate/i.test(error.message)) throw error;
      coverBucketReady = true;
    }
    const cover_path = `tiktok/${videoId}.jpg`;
    const { error: upErr } = await db.storage.from(COVER_BUCKET)
      .upload(cover_path, fs.readFileSync(frame.path), { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw upErr;
    const { data } = db.storage.from(COVER_BUCKET).getPublicUrl(cover_path);
    return { cover_path, cover_url: data?.publicUrl || null };
  } catch (e) {
    console.warn(`    [cover] ${videoId}: ${e.message}`);
    return { cover_path: null, cover_url: null };
  }
}

async function processRow(row, formats) {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), `vb_${row.video_id}_`));
  try {
    const file = await download(row.url, wd);
    const duration = await durationOf(file);
    // Rolka bez ścieżki audio (sam podkład/nagranie ekranu) -> ffmpeg wywala "Invalid argument".
    // Degradujemy: pusta transkrypcja + sama wizja, zamiast oznaczać cały wiersz jako error.
    const mp3P = extractAudio(file, wd).catch((e) => {
      console.warn(`    [audio] ${row.video_id}: pomijam transkrypcję (${String(e.message).slice(0, 80)})`);
      return null;
    });
    const [mp3, frames] = await Promise.all([mp3P, extractFrames(file, wd, duration)]);
    const [tr, vis] = await Promise.all([
      mp3 ? llm.transcribe({ buffer: fs.readFileSync(mp3), filename: 'a.mp3', mime: 'audio/mpeg', language: 'pl' })
          : Promise.resolve({ text: '', model: null }),
      analyzeVisual(frames, row.caption, formats),
    ]);
    const v = (vis.visual && typeof vis.visual === 'object') ? vis.visual : {};
    const known = new Set((formats || []).map((f) => f.slug));
    const formatSlug = known.has(v.format) ? v.format : null;
    const cover = await uploadCover(frames, row.video_id);
    const { error } = await db.from('marketing_video_analysis').update({
      duration_s: Math.round(duration) || row.duration_s,
      transcript: tr.text, transcript_src: 'whisper', hook: hookOf(tr.text), model_transcribe: tr.model,
      visual: vis.visual, frames_n: frames.length, model_visual: vis.model,
      cover_path: cover.cover_path, cover_url: cover.cover_url,
      format: formatSlug, format_conf: formatSlug ? (Number(v.format_conf) || null) : null,
      format_source: formatSlug ? 'auto' : null,
      status: 'done', error: null, updated_at: new Date().toISOString(),
    }).eq('platform', 'tiktok').eq('video_id', row.video_id);
    if (error) throw new Error(`update: ${error.message}`);
    return { ok: true };
  } catch (e) {
    const msg = e.stderr ? `${e.message} :: ${String(e.stderr).slice(0, 200)}` : e.message;
    await db.from('marketing_video_analysis').update({ status: 'error', error: msg, updated_at: new Date().toISOString() })
      .eq('platform', 'tiktok').eq('video_id', row.video_id);
    return { ok: false, error: msg };
  } finally { try { fs.rmSync(wd, { recursive: true, force: true }); } catch (_) {} }
}

async function main() {
  FFMPEG = resolveFfmpeg();
  console.log(`ffmpeg: ${FFMPEG}`);

  // Debug: klasyfikacja 1 URL bez Apify i bez zapisu (walidacja promptu/taksonomii).
  if (CLASSIFY_URL) {
    const formats = await loadFormats();
    console.log(`[formaty] ${formats.length} formatow.`);
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'vb_classify_'));
    try {
      const file = await download(CLASSIFY_URL, wd);
      const frames = await extractFrames(file, wd, await durationOf(file));
      const vis = await analyzeVisual(frames, '', formats);
      console.log(JSON.stringify(vis.visual, null, 2));
    } finally { try { fs.rmSync(wd, { recursive: true, force: true }); } catch (_) {} }
    return;
  }

  if (NO_ENUMERATE) {
    const { count } = await db.from('marketing_video_analysis').select('video_id', { count: 'exact', head: true }).eq('platform', 'tiktok');
    console.log(`[apify] pominieto re-listing (--no-enumerate). W bazie: ${count} rolek.`);
  } else {
    if (!process.env.APIFY_TOKEN) throw new Error('brak APIFY_TOKEN w apps/komunikator/server/.env');
    const items = await enumerateProfile();
    await upsertEnumerated(items);
  }

  if (ENUMERATE_ONLY) {
    const { count } = await db.from('marketing_video_analysis').select('video_id', { count: 'exact', head: true }).eq('platform', 'tiktok');
    console.log(`\n=== ENUMERACJA DONE. Rolek w bazie: ${count}. Uruchom bez --enumerate-only aby przetworzyć (~$0.2/rolka). ===`);
    return;
  }

  const formats = await loadFormats();
  console.log(`[formaty] wczytano ${formats.length} formatow do klasyfikacji.`);

  let q = db.from('marketing_video_analysis').select('video_id,url,caption,duration_s,status')
    .eq('platform', 'tiktok').not('url', 'is', null).order('published_at', { ascending: false });
  if (!REPROCESS) q = q.neq('status', 'done');
  let { data: rows } = await q;
  rows = rows || [];
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`\n[proc] do przetworzenia: ${rows.length}${LIMIT ? ` (limit ${LIMIT})` : ''}`);

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(`  [${i + 1}/${rows.length}] ${rows[i].video_id} … `);
    const r = await processRow(rows[i], formats);
    console.log(r.ok ? 'OK' : `FAIL: ${r.error}`);
    if (r.ok) ok += 1; else fail += 1;
    await sleep(800);
  }
  console.log(`\n=== DONE. OK ${ok}, FAIL ${fail}. ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
