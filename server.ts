import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import { Innertube } from 'youtubei.js';

const PORT = 3000;
const TEMP_DIR = path.join(os.tmpdir(), 'enlaceflow-media');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 150 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: '2mb' }));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface NotubePendingJob {
  serverNum: number;
  videoUrl: string;
  format: 'mp4hd' | 'mp4' | 'mp3' | 'm4a';
  nameMp4: string;
  token: string;
  requiresConversion?: boolean;
}

interface CachedMediaTarget {
  url?: string;
  audioUrl?: string;
  headers: Record<string, string>;
  deferredNotube?: NotubePendingJob;
  expiresAt: number;
}

const mediaTokenCache = new Map<string, CachedMediaTarget>();

function cacheMediaTarget(
  url: string,
  headers: Record<string, string> = {},
  audioUrl?: string
): string {
  const now = Date.now();
  for (const [k, v] of mediaTokenCache.entries()) {
    if (v.expiresAt < now) mediaTokenCache.delete(k);
  }
  const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
  mediaTokenCache.set(token, {
    url,
    audioUrl,
    headers,
    expiresAt: now + 30 * 60 * 1000,
  });
  return token;
}

function cacheDeferredNotubeTarget(job: NotubePendingJob): string {
  const now = Date.now();
  for (const [k, v] of mediaTokenCache.entries()) {
    if (v.expiresAt < now) mediaTokenCache.delete(k);
  }
  const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
  mediaTokenCache.set(token, {
    headers: {},
    deferredNotube: job,
    expiresAt: now + 30 * 60 * 1000,
  });
  return token;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === 'ip6-localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }
  if (net.isIP(lower)) {
    if (lower === '::1' || lower === '0.0.0.0') return true;
    if (lower.startsWith('127.') || lower.startsWith('10.') || lower.startsWith('169.254.')) return true;
    if (lower.startsWith('192.168.')) return true;
    if (lower.startsWith('172.')) {
      const second = parseInt(lower.split('.')[1] || '0', 10);
      if (second >= 16 && second <= 31) return true;
    }
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  }
  return false;
}

function validateExternalUrl(raw: string): URL {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Solo se admiten enlaces HTTP o HTTPS.');
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error('Host no permitido por seguridad.');
  }
  return parsed;
}

const NOTUBE_SERVERS = [60, 61, 62, 63, 64, 65, 55, 56, 57, 58, 59, 50, 51, 52, 66, 67, 68, 69, 70, 71, 72];
let lastHealthyNotubeServer = 60;

async function findHealthyNotubeServer(exclude: number[] = []): Promise<number> {
  const ordered = [
    lastHealthyNotubeServer,
    ...NOTUBE_SERVERS.filter((n) => n !== lastHealthyNotubeServer),
  ].filter((n) => !exclude.includes(n));

  for (const num of ordered.slice(0, 6)) {
    try {
      const r = await fetch(`https://s${num}.notube.im/weight.php`, {
        headers: { 'User-Agent': BROWSER_UA, Origin: 'https://notube.im', Referer: 'https://notube.im/' },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        lastHealthyNotubeServer = num;
        return num;
      }
    } catch {
      // try next server
    }
  }
  return 60;
}

interface NotubeWeightResp {
  url_mp4_youtube?: string;
  weight_total?: string | number;
  name_mp4?: string;
  titre_mp4?: string;
  token?: string;
  VevoUSA?: string;
  VideoDuration?: string;
}

async function callNotubeWeight(
  serverNum: number,
  videoUrl: string,
  format: 'mp4hd' | 'mp4' | 'mp3' | 'm4a'
): Promise<NotubeWeightResp> {
  const resp = await fetch(`https://s${serverNum}.notube.im/recover_weight.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      Origin: 'https://notube.im',
      Referer: 'https://notube.im/',
    },
    body: new URLSearchParams({
      url: videoUrl,
      format,
      lang: 'es',
      subscribed: 'false',
    }),
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) {
    throw new Error(`Servidor remoto respondió ${resp.status}`);
  }
  return (await resp.json()) as NotubeWeightResp;
}

async function resolveNotubeJob(job: NotubePendingJob): Promise<string> {
  const tryOnServer = async (
    serverNum: number,
    token: string,
    nameMp4: string
  ): Promise<{ ok: boolean; busy: boolean; finalToken: string; errorMsg?: string }> => {
    const rfResp = await fetch(`https://s${serverNum}.notube.im/recover_file.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BROWSER_UA,
        Origin: 'https://notube.im',
        Referer: 'https://notube.im/',
      },
      body: new URLSearchParams({
        url: job.videoUrl,
        format: job.format,
        name_mp4: nameMp4,
        lang: 'es',
        token,
        subscribed: 'false',
        playlist: 'false',
        adblock: 'false',
      }),
      signal: AbortSignal.timeout(50000),
    });
    const raw = await rfResp.text();
    let retour = raw.trim();
    let finalToken = token;
    try {
      const parsed = JSON.parse(raw) as { retour?: string; token?: string };
      if (parsed.retour) retour = parsed.retour;
      if (parsed.token) finalToken = parsed.token;
    } catch {
      // ignore non-json
    }
    if (retour === 'OK') {
      return { ok: true, busy: false, finalToken };
    }
    if (retour === 'HS') {
      return { ok: false, busy: true, finalToken };
    }
    if (retour === 'exceeded' || retour === 'limitation') {
      return {
        ok: false,
        busy: false,
        finalToken,
        errorMsg: 'El servidor de extracción alcanzó el límite temporal. Intenta de nuevo en unos segundos.',
      };
    }
    return {
      ok: false,
      busy: false,
      finalToken,
      errorMsg: 'No se pudo preparar este video para descarga en este momento.',
    };
  };

  let activeServer = job.serverNum;
  let activeToken = job.token;
  let activeName = job.nameMp4;
  let result = await tryOnServer(activeServer, activeToken, activeName);

  if (!result.ok && result.busy) {
    const altServer = await findHealthyNotubeServer([activeServer]);
    const w = await callNotubeWeight(altServer, job.videoUrl, job.format);
    if (w.token && w.name_mp4) {
      activeServer = altServer;
      activeToken = w.token;
      activeName = w.name_mp4;
      result = await tryOnServer(activeServer, activeToken, activeName);
    }
  }

  if (!result.ok) {
    throw new Error(result.errorMsg || 'No se pudo procesar el video en el servidor de extracción.');
  }

  if (job.requiresConversion) {
    await fetch(`https://s${activeServer}.notube.im/conversion.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BROWSER_UA,
        Origin: 'https://notube.im',
        Referer: 'https://notube.im/',
      },
      body: new URLSearchParams({ token: result.finalToken }),
      signal: AbortSignal.timeout(35000),
    }).catch(() => undefined);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const dlPage = await fetch(
      `https://notube.im/es/download?token=${encodeURIComponent(result.finalToken)}`,
      {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(10000),
      }
    );
    const html = await dlPage.text();
    const linkMatch = html.match(/https?:\/\/s\d+\.notube\.(?:im|net)\/download\.php\?[^"'\s<]+/);
    if (linkMatch?.[0]) {
      return linkMatch[0];
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  throw new Error('No se encontró el enlace final de descarga generado.');
}

async function resolveMediaSourceAsync(rawOrToken: string): Promise<{
  url: string;
  audioUrl?: string;
  headers: Record<string, string>;
  sourceFormat?: string;
}> {
  if (rawOrToken.startsWith('tok_')) {
    const cached = mediaTokenCache.get(rawOrToken);
    if (!cached || cached.expiresAt < Date.now()) {
      mediaTokenCache.delete(rawOrToken);
      throw new Error('El enlace temporal expiró. Analiza la publicación nuevamente.');
    }
    const sourceFormat = cached.deferredNotube?.format;
    if (!cached.url && cached.deferredNotube) {
      const resolved = await resolveNotubeJob(cached.deferredNotube);
      cached.url = resolved;
      cached.deferredNotube = undefined;
    }
    if (!cached.url) {
      throw new Error('El enlace temporal no devolvió una fuente descargable válida.');
    }
    validateExternalUrl(cached.url);
    if (cached.audioUrl) {
      validateExternalUrl(cached.audioUrl);
    }
    return { url: cached.url, audioUrl: cached.audioUrl, headers: cached.headers, sourceFormat };
  }
  const parsed = validateExternalUrl(rawOrToken);
  return { url: parsed.toString(), headers: {} };
}

function sanitizeFilename(name: string, fallbackExt: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._\-\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  if (!cleaned) return `archivo_${Date.now()}.${fallbackExt}`;
  if (cleaned.includes('.')) return cleaned;
  return `${cleaned}.${fallbackExt}`;
}

function extractYouTubeId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
        const id = parts[1];
        return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function detectPlatform(rawUrl: string): 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'direct' {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('youtube-nocookie.com')) {
      return 'youtube';
    }
    if (host.includes('tiktok.com') || host.includes('tiktokv.com')) return 'tiktok';
    if (host.includes('instagram.com') || host.includes('instagr.am') || host.includes('ig.me')) {
      return 'instagram';
    }
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) {
      return 'facebook';
    }
  } catch {
    // ignore
  }
  return 'direct';
}

async function resolveRedirectIfNeeded(parsed: URL): Promise<URL> {
  const initialPlatform = detectPlatform(parsed.toString());
  const host = parsed.hostname.toLowerCase();
  const isShortener =
    [
      'bit.ly',
      'tinyurl.com',
      't.co',
      'cutt.ly',
      'rebrand.ly',
      'buff.ly',
      'ow.ly',
      'rb.gy',
      'is.gd',
      'share.google',
      'fb.watch',
      'ig.me',
      'vm.tiktok.com',
      'vt.tiktok.com',
    ].some((d) => host === d || host.endsWith(`.${d}`)) ||
    (host.includes('tiktok.com') && parsed.pathname.startsWith('/t/'));

  if (initialPlatform !== 'direct' && !isShortener && !parsed.pathname.includes('/share/')) {
    return parsed;
  }

  try {
    const resp = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(5000),
    });
    await resp.body?.cancel();
    if (resp.url) {
      return validateExternalUrl(resp.url);
    }
  } catch {
    // Fall back to original URL
  }
  return parsed;
}

function isNonMediaContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes('text/html') ||
    lower.includes('application/xhtml+xml') ||
    lower.includes('text/plain') ||
    lower.includes('application/json') ||
    lower.includes('application/xml') ||
    lower.includes('text/xml')
  );
}

function bufferLooksLikeTextMarkup(buf: Buffer): boolean {
  const prefix = buf.subarray(0, 128).toString('utf8').trimStart().toLowerCase();
  return (
    prefix.startsWith('<!doctype') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<?xml') ||
    prefix.startsWith('<head') ||
    prefix.startsWith('<body') ||
    prefix.startsWith('{"error')
  );
}

interface MediaOption {
  id: string;
  label: string;
  format: 'mp4' | 'mp3' | 'jpg' | 'm4a' | 'webm';
  quality: string;
  resolution?: string;
  dimensions?: string;
  url: string;
  audioSourceUrl?: string;
  filename: string;
  sizeBytes?: number;
  noWatermark?: boolean;
  canConvertMp3?: boolean;
}

interface InspectResult {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'direct';
  title: string;
  author: string;
  thumbnail: string;
  durationSec?: number;
  options: MediaOption[];
  warning?: string;
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/media/thumbnails', async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const videoId = extractYouTubeId(rawUrl);
    if (!videoId) {
      res.status(400).json({ error: 'Ingresa una URL válida de YouTube (watch, shorts o youtu.be).' });
      return;
    }

    let title = `YouTube ${videoId}`;
    let author = 'Canal de YouTube';
    try {
      const oembedResp = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
        { signal: AbortSignal.timeout(4500) }
      );
      if (oembedResp.ok) {
        const text = await oembedResp.text();
        try {
          const meta = JSON.parse(text) as { title?: string; author_name?: string };
          if (meta.title) title = meta.title;
          if (meta.author_name) author = meta.author_name;
        } catch {
          // ignore non-JSON
        }
      }
    } catch {
      // Fallback to generic title
    }

    const variants = [
      { key: 'maxresdefault', label: 'Full HD (MaxRes)', width: 1280, height: 720 },
      { key: 'sddefault', label: 'Estándar HD (SD)', width: 640, height: 480 },
      { key: 'hqdefault', label: 'Alta Calidad (HQ)', width: 480, height: 360 },
      { key: 'mqdefault', label: 'Media (MQ)', width: 320, height: 180 },
      { key: 'default', label: 'Miniatura Compacta', width: 120, height: 90 },
    ];

    const checked = await Promise.all(
      variants.map(async (v) => {
        const imgUrl = `https://i.ytimg.com/vi/${videoId}/${v.key}.jpg`;
        let available = false;
        let sizeBytes = 0;
        try {
          const head = await fetch(imgUrl, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
          if (head.ok) {
            available = true;
            const len = head.headers.get('content-length');
            if (len) sizeBytes = parseInt(len, 10) || 0;
          }
        } catch {
          available = false;
        }
        return {
          ...v,
          url: imgUrl,
          available,
          sizeBytes,
          filename: sanitizeFilename(`${title}_${v.key}`, 'jpg'),
        };
      })
    );

    res.json({
      videoId,
      title,
      author,
      thumbnails: checked.filter((t) => t.available),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Error al obtener miniaturas.' });
  }
});

function parseTikTokResolution(gearName?: string, width?: number, height?: number): {
  resolution: string;
  label: string;
  rank: number;
} {
  const shortSide = width && height ? Math.min(width, height) : 0;
  const g = (gearName || '').toLowerCase();
  if (shortSide >= 1080 || g.includes('1080')) {
    return { resolution: '1080p', label: 'Video MP4 Full HD (1080p)', rank: 1080 };
  }
  if (shortSide >= 720 || g.includes('720')) {
    return { resolution: '720p', label: 'Video MP4 HD (720p)', rank: 720 };
  }
  if (shortSide >= 540 || g.includes('540')) {
    return { resolution: '540p', label: 'Video MP4 Estándar (540p)', rank: 540 };
  }
  if (shortSide >= 480 || g.includes('480')) {
    return { resolution: '480p', label: 'Video MP4 Ligero (480p)', rank: 480 };
  }
  return { resolution: 'HD', label: 'Video MP4 Sin Marca de Agua', rank: 600 };
}

async function inspectTikTok(rawUrl: string): Promise<InspectResult> {
  const resp = await fetch(rawUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(8500),
  });

  if (!resp.ok) {
    throw new Error('No se pudo acceder a este enlace de TikTok. Verifica que el video sea público.');
  }

  const rawCookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');
  const html = await resp.text();

  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match?.[1]) {
    throw new Error('No se encontraron los datos del video de TikTok (puede requerir verificación o ser privado).');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    throw new Error('No se pudieron interpretar los metadatos de TikTok.');
  }

  const defaultScope = parsed['__DEFAULT_SCOPE__'] as Record<string, unknown> | undefined;
  const videoDetail = defaultScope?.['webapp.video-detail'] as Record<string, unknown> | undefined;
  const itemInfo = videoDetail?.['itemInfo'] as Record<string, unknown> | undefined;
  const item = itemInfo?.['itemStruct'] as {
    desc?: string;
    author?: { nickname?: string; uniqueId?: string };
    video?: {
      duration?: number;
      width?: number;
      height?: number;
      size?: number;
      cover?: string;
      originCover?: string;
      playAddr?: string;
      downloadAddr?: string;
      bitrateInfo?: Array<{
        GearName?: string;
        PlayAddr?: { UrlList?: string[]; DataSize?: string; Width?: number; Height?: number };
      }>;
    };
    music?: { title?: string; playUrl?: string };
    imagePost?: {
      images?: Array<{ imageURL?: { urlList?: string[] } }>;
    };
  } | undefined;

  if (!item) {
    throw new Error('Este video de TikTok no está disponible o fue eliminado.');
  }

  const title = item.desc?.trim() || 'Video de TikTok';
  const author =
    item.author?.nickname || (item.author?.uniqueId ? `@${item.author.uniqueId}` : 'TikTok');
  const thumbnail = item.video?.originCover || item.video?.cover || '';
  const headers = {
    Referer: 'https://www.tiktok.com/',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const audioToken = item.music?.playUrl ? cacheMediaTarget(item.music.playUrl, headers) : undefined;
  const videoCandidates: Array<MediaOption & { rank: number }> = [];
  const seenUrls = new Set<string>();
  const seenResolutions = new Set<string>();

  if (Array.isArray(item.video?.bitrateInfo)) {
    for (const b of item.video.bitrateInfo) {
      const candidateUrl = b.PlayAddr?.UrlList?.[0];
      if (!candidateUrl || seenUrls.has(candidateUrl)) continue;
      const w = b.PlayAddr?.Width || item.video?.width;
      const h = b.PlayAddr?.Height || item.video?.height;
      const meta = parseTikTokResolution(b.GearName, w, h);
      if (seenResolutions.has(meta.resolution)) continue;
      seenUrls.add(candidateUrl);
      seenResolutions.add(meta.resolution);
      const token = cacheMediaTarget(candidateUrl, headers);
      videoCandidates.push({
        id: `tt-${meta.resolution}-${videoCandidates.length}`,
        label: meta.label,
        format: 'mp4',
        quality: meta.resolution,
        resolution: meta.resolution,
        dimensions: w && h ? `${w}×${h}` : undefined,
        url: token,
        audioSourceUrl: audioToken,
        filename: sanitizeFilename(`${title}_tiktok_${meta.resolution}`, 'mp4'),
        sizeBytes: b.PlayAddr?.DataSize ? Number(b.PlayAddr.DataSize) : undefined,
        noWatermark: true,
        canConvertMp3: true,
        rank: meta.rank,
      });
    }
  }

  if (item.video?.playAddr && !seenUrls.has(item.video.playAddr)) {
    const w = item.video?.width;
    const h = item.video?.height;
    const meta = parseTikTokResolution('original', w, h);
    if (!seenResolutions.has(meta.resolution) || videoCandidates.length === 0) {
      const token = cacheMediaTarget(item.video.playAddr, headers);
      videoCandidates.push({
        id: 'tt-no-wm',
        label: 'Video MP4 Original (Sin Marca de Agua)',
        format: 'mp4',
        quality: meta.resolution,
        resolution: meta.resolution,
        dimensions: w && h ? `${w}×${h}` : undefined,
        url: token,
        audioSourceUrl: audioToken,
        filename: sanitizeFilename(`${title}_tiktok`, 'mp4'),
        sizeBytes: item.video?.size ? Number(item.video.size) : undefined,
        noWatermark: true,
        canConvertMp3: true,
        rank: meta.rank + 1,
      });
    }
  }

  videoCandidates.sort((a, b) => b.rank - a.rank);
  const options: MediaOption[] = videoCandidates.map(({ rank: _rank, ...rest }) => rest);

  if (audioToken && item.music?.playUrl) {
    options.push({
      id: 'tt-music',
      label: `Audio Original (${item.music.title || 'Sonido'})`,
      format: 'mp3',
      quality: 'MP3 Original',
      resolution: 'Audio',
      url: audioToken,
      filename: sanitizeFilename(`${title}_audio`, 'mp3'),
    });
  }

  if (Array.isArray(item.imagePost?.images)) {
    item.imagePost.images.forEach((img, idx) => {
      const imgUrl = img.imageURL?.urlList?.[0];
      if (imgUrl) {
        const token = cacheMediaTarget(imgUrl, headers);
        options.push({
          id: `tt-img-${idx}`,
          label: `Imagen de Carrusel #${idx + 1}`,
          format: 'jpg',
          quality: 'JPG Original',
          url: token,
          filename: sanitizeFilename(`${title}_slide_${idx + 1}`, 'jpg'),
        });
      }
    });
  }

  if (options.length === 0) {
    throw new Error('No se encontraron flujos descargables en este enlace de TikTok.');
  }

  return {
    platform: 'tiktok',
    title,
    author,
    thumbnail,
    durationSec: item.video?.duration,
    options,
  };
}

interface AdaptiveFormatLike {
  itag?: number;
  url?: string;
  mime_type?: string;
  quality_label?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  content_length?: number | string;
  decipher?: (player: unknown) => Promise<string>;
}

async function inspectTikTokViaNotube(rawUrl: string): Promise<InspectResult> {
  const serverNum = await findHealthyNotubeServer();
  const [mp4Res, mp3Res] = await Promise.allSettled([
    callNotubeWeight(serverNum, rawUrl, 'mp4'),
    callNotubeWeight(serverNum, rawUrl, 'mp3'),
  ]);

  const mp4Data = mp4Res.status === 'fulfilled' ? mp4Res.value : null;
  const mp3Data = mp3Res.status === 'fulfilled' ? mp3Res.value : null;

  let title = 'Video de TikTok';
  const rawTitre = mp4Data?.titre_mp4 || mp3Data?.titre_mp4;
  if (rawTitre) {
    try {
      title = decodeURIComponent(rawTitre.replace(/\+/g, ' ')).trim() || title;
    } catch {
      title = rawTitre.replace(/\+/g, ' ').trim() || title;
    }
  }

  const options: MediaOption[] = [];
  let audioToken: string | undefined;
  if (mp3Data?.token && mp3Data?.name_mp4) {
    audioToken = cacheDeferredNotubeTarget({
      serverNum,
      videoUrl: rawUrl,
      format: 'mp3',
      nameMp4: mp3Data.name_mp4,
      token: mp3Data.token,
      requiresConversion: true,
    });
  }

  if (mp4Data?.token && mp4Data?.name_mp4) {
    const vidToken = cacheDeferredNotubeTarget({
      serverNum,
      videoUrl: rawUrl,
      format: 'mp4',
      nameMp4: mp4Data.name_mp4,
      token: mp4Data.token,
      requiresConversion: true,
    });
    const parsedSize = Number(mp4Data.weight_total);
    options.push({
      id: 'tt-notube-hd',
      label: 'Video MP4 HD (Sin Marca de Agua)',
      format: 'mp4',
      quality: '720p HD',
      resolution: '720p',
      url: vidToken,
      audioSourceUrl: audioToken,
      filename: sanitizeFilename(`${title}_tiktok`, 'mp4'),
      sizeBytes: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : undefined,
      noWatermark: true,
      canConvertMp3: true,
    });
  }

  if (audioToken) {
    options.push({
      id: 'tt-notube-mp3',
      label: 'Audio MP3 Extraído',
      format: 'mp3',
      quality: 'MP3 192 kbps',
      resolution: 'Audio',
      url: audioToken,
      filename: sanitizeFilename(`${title}_tiktok`, 'mp3'),
    });
  }

  if (options.length === 0) {
    throw new Error('No se pudo extraer este enlace de TikTok. Verifica que el video sea público.');
  }

  return {
    platform: 'tiktok',
    title,
    author: 'TikTok',
    thumbnail: '',
    options,
  };
}

async function inspectYouTubeViaNotube(
  videoId: string,
  currentTitle: string,
  currentAuthor: string
): Promise<{ title: string; options: MediaOption[] }> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const serverNum = await findHealthyNotubeServer();

  const [hdRes, sdRes, mp3Res] = await Promise.allSettled([
    callNotubeWeight(serverNum, canonicalUrl, 'mp4hd'),
    callNotubeWeight(serverNum, canonicalUrl, 'mp4'),
    callNotubeWeight(serverNum, canonicalUrl, 'mp3'),
  ]);

  const hdData = hdRes.status === 'fulfilled' ? hdRes.value : null;
  const sdData = sdRes.status === 'fulfilled' ? sdRes.value : null;
  const mp3Data = mp3Res.status === 'fulfilled' ? mp3Res.value : null;

  let resolvedTitle = currentTitle;
  const rawTitre = hdData?.titre_mp4 || sdData?.titre_mp4 || mp3Data?.titre_mp4;
  if (rawTitre && resolvedTitle.startsWith('YouTube Video (')) {
    try {
      resolvedTitle = decodeURIComponent(rawTitre.replace(/\+/g, ' ')).trim() || resolvedTitle;
    } catch {
      resolvedTitle = rawTitre.replace(/\+/g, ' ').trim() || resolvedTitle;
    }
  }

  let mp3Token: string | undefined;
  if (mp3Data?.token && mp3Data?.name_mp4) {
    mp3Token = cacheDeferredNotubeTarget({
      serverNum,
      videoUrl: canonicalUrl,
      format: 'mp3',
      nameMp4: mp3Data.name_mp4,
      token: mp3Data.token,
      requiresConversion: false,
    });
  }

  const options: MediaOption[] = [];

  if (hdData?.token && hdData?.name_mp4 && hdData.VideoDuration !== '1') {
    const parsedSize = Number(hdData.weight_total);
    const hdToken = cacheDeferredNotubeTarget({
      serverNum,
      videoUrl: canonicalUrl,
      format: 'mp4hd',
      nameMp4: hdData.name_mp4,
      token: hdData.token,
      requiresConversion: false,
    });
    options.push({
      id: 'yt-notube-720p',
      label: 'Video MP4 Alta Definición (720p HD)',
      format: 'mp4',
      quality: '720p HD',
      resolution: '720p',
      dimensions: '1280×720',
      url: hdToken,
      audioSourceUrl: mp3Token,
      filename: sanitizeFilename(`${resolvedTitle}_720p`, 'mp4'),
      sizeBytes: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : undefined,
      canConvertMp3: true,
    });
  }

  if (sdData?.token && sdData?.name_mp4 && sdData.VideoDuration !== '1') {
    const parsedSize = Number(sdData.weight_total);
    const sdToken = cacheDeferredNotubeTarget({
      serverNum,
      videoUrl: canonicalUrl,
      format: 'mp4',
      nameMp4: sdData.name_mp4,
      token: sdData.token,
      requiresConversion: false,
    });
    options.push({
      id: 'yt-notube-360p',
      label: 'Video MP4 Estándar (360p SD)',
      format: 'mp4',
      quality: '360p SD',
      resolution: '360p',
      dimensions: '640×360',
      url: sdToken,
      audioSourceUrl: mp3Token,
      filename: sanitizeFilename(`${resolvedTitle}_360p`, 'mp4'),
      sizeBytes: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : undefined,
      canConvertMp3: true,
    });
  }

  if (mp3Token) {
    options.push({
      id: 'yt-notube-mp3',
      label: `Audio MP3 Directo (${currentAuthor})`,
      format: 'mp3',
      quality: 'MP3 192 kbps',
      resolution: 'Audio',
      url: mp3Token,
      filename: sanitizeFilename(`${resolvedTitle}_audio`, 'mp3'),
      canConvertMp3: false,
    });
  }

  return { title: resolvedTitle, options };
}

async function inspectYouTube(rawUrl: string): Promise<InspectResult> {
  const videoId = extractYouTubeId(rawUrl);
  if (!videoId) {
    throw new Error('URL de YouTube no reconocida.');
  }

  let title = `YouTube Video (${videoId})`;
  let author = 'YouTube';
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembed = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(4500) }
    );
    if (oembed.ok) {
      const rawText = await oembed.text();
      try {
        const meta = JSON.parse(rawText) as { title?: string; author_name?: string };
        if (meta.title) title = meta.title;
        if (meta.author_name) author = meta.author_name;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const options: MediaOption[] = [];
  let warning: string | undefined;
  let durationSec: number | undefined;

  try {
    const cookie = process.env.YOUTUBE_COOKIE?.trim();
    const yt = await Innertube.create({
      generate_session_locally: true,
      ...(cookie ? { cookie } : {}),
    });

    interface StreamingDataLike {
      formats?: AdaptiveFormatLike[];
      adaptive_formats?: AdaptiveFormatLike[];
    }

    const clientsToTry = ['IOS', 'ANDROID'] as const;
    let streaming: StreamingDataLike | null = null;

    for (const client of clientsToTry) {
      try {
        const info = await yt.getBasicInfo(videoId, { client });
        if (info.basic_info?.title) title = info.basic_info.title;
        if (info.basic_info?.author) author = info.basic_info.author;
        if (info.basic_info?.duration) durationSec = info.basic_info.duration;

        const candidate = info.streaming_data;
        const count =
          (candidate?.formats?.length || 0) + (candidate?.adaptive_formats?.length || 0);
        if (candidate && count > 0) {
          streaming = candidate as unknown as StreamingDataLike;
          break;
        }
      } catch {
        // Try next client
      }
    }

    if (streaming) {
      const adaptive = streaming.adaptive_formats || [];
      const audioFormats = adaptive
        .filter((f) => String(f.mime_type || '').startsWith('audio/'))
        .sort((a, b) => {
          const aMp4 = String(a.mime_type || '').includes('audio/mp4') ? 1 : 0;
          const bMp4 = String(b.mime_type || '').includes('audio/mp4') ? 1 : 0;
          if (aMp4 !== bMp4) return bMp4 - aMp4;
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      let bestAudioUrl = '';
      let bestAudioSize = 0;
      let bestAudioBitrate = 128000;
      for (const af of audioFormats) {
        const resolved = af.url || (af.decipher ? await af.decipher(yt.session.player).catch(() => '') : '');
        if (resolved) {
          bestAudioUrl = resolved;
          bestAudioSize = af.content_length ? Number(af.content_length) : 0;
          bestAudioBitrate = af.bitrate || 128000;
          break;
        }
      }

      const audioToken = bestAudioUrl ? cacheMediaTarget(bestAudioUrl, {}) : undefined;

      const videoAdaptive = adaptive
        .filter((f) => String(f.mime_type || '').startsWith('video/mp4'))
        .sort((a, b) => {
          const aAvc = String(a.mime_type || '').includes('avc1') ? 1 : 0;
          const bAvc = String(b.mime_type || '').includes('avc1') ? 1 : 0;
          if (aAvc !== bAvc) return bAvc - aAvc;
          return (b.height || 0) - (a.height || 0);
        });

      const seenResolutions = new Set<string>();
      const collectedVideos: Array<MediaOption & { heightRank: number }> = [];

      for (const vf of videoAdaptive) {
        const height = vf.height || 0;
        const rawRes = vf.quality_label || (height ? `${height}p` : '');
        const normResMatch = rawRes.match(/(\d+p)/i);
        const normRes = normResMatch ? normResMatch[1].toLowerCase() : rawRes;
        if (!normRes || !['2160p', '1440p', '1080p', '720p', '480p', '360p'].includes(normRes)) {
          continue;
        }
        if (seenResolutions.has(normRes)) continue;

        const videoUrl = vf.url || (vf.decipher ? await vf.decipher(yt.session.player).catch(() => '') : '');
        if (!videoUrl) continue;

        seenResolutions.add(normRes);
        const token = cacheMediaTarget(videoUrl, {}, bestAudioUrl || undefined);
        const vSize = vf.content_length ? Number(vf.content_length) : 0;
        const totalSize = vSize > 0 ? vSize + bestAudioSize : undefined;

        collectedVideos.push({
          id: `yt-hd-${normRes}-${vf.itag || collectedVideos.length}`,
          label: `Video MP4 (${normRes.toUpperCase()})`,
          format: 'mp4',
          quality: normRes,
          resolution: normRes,
          dimensions: vf.width && vf.height ? `${vf.width}×${vf.height}` : undefined,
          url: token,
          audioSourceUrl: audioToken,
          filename: sanitizeFilename(`${title}_${normRes}`, 'mp4'),
          sizeBytes: totalSize,
          canConvertMp3: true,
          heightRank: height || parseInt(normRes, 10) || 0,
        });
      }

      for (const fmt of streaming.formats || []) {
        const rawRes = fmt.quality_label || '360p';
        const normResMatch = rawRes.match(/(\d+p)/i);
        const normRes = normResMatch ? normResMatch[1].toLowerCase() : rawRes;
        if (seenResolutions.has(normRes)) continue;
        const directUrl = fmt.url || (fmt.decipher ? await fmt.decipher(yt.session.player).catch(() => '') : '');
        if (!directUrl) continue;
        seenResolutions.add(normRes);
        const token = cacheMediaTarget(directUrl, {});
        collectedVideos.push({
          id: `yt-fmt-${fmt.itag || normRes}`,
          label: `Video MP4 (${normRes.toUpperCase()})`,
          format: 'mp4',
          quality: normRes,
          resolution: normRes,
          dimensions: fmt.width && fmt.height ? `${fmt.width}×${fmt.height}` : undefined,
          url: token,
          audioSourceUrl: audioToken,
          filename: sanitizeFilename(`${title}_${normRes}`, 'mp4'),
          sizeBytes: fmt.content_length ? Number(fmt.content_length) : undefined,
          canConvertMp3: true,
          heightRank: fmt.height || parseInt(normRes, 10) || 360,
        });
      }

      collectedVideos.sort((a, b) => b.heightRank - a.heightRank);
      for (const { heightRank: _hr, ...opt } of collectedVideos) {
        options.push(opt);
      }

      if (audioToken) {
        options.push({
          id: `yt-audio-best`,
          label: 'Pista de Audio Directa (Convertible a MP3)',
          format: 'm4a',
          quality: `${Math.round(bestAudioBitrate / 1000)} kbps`,
          resolution: 'Audio',
          url: audioToken,
          filename: sanitizeFilename(`${title}_audio`, 'm4a'),
          sizeBytes: bestAudioSize || undefined,
          canConvertMp3: true,
        });
      }
    }
  } catch {
    // Will try cloud fallback below
  }

  // Fallback extractor when direct Innertube streams are blocked by datacenter anti-bot checks
  if (options.length === 0) {
    try {
      const cloudRes = await inspectYouTubeViaNotube(videoId, title, author);
      title = cloudRes.title;
      options.push(...cloudRes.options);
    } catch {
      // Keep clean warning if fallback also fails
    }
  }

  if (options.length === 0) {
    warning =
      'No se pudieron obtener flujos MP4/MP3 para este video de YouTube en este momento (puede tener restricción de duración o privacidad). Puedes descargar sus miniaturas HD en Miniaturas YouTube o convertir un archivo local a MP3.';
  }

  return {
    platform: 'youtube',
    title,
    author,
    thumbnail,
    durationSec,
    options,
    warning,
  };
}

function unescapeEmbeddedUrl(raw: string): string {
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

async function inspectInstagram(rawUrl: string): Promise<InspectResult> {
  const match = rawUrl.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i);
  if (!match) {
    throw new Error('Ingresa un enlace válido de publicación o Reel de Instagram (/p/ o /reel/).');
  }
  const shortcode = match[1];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error('Instagram no permitió acceder a la publicación. Verifica que sea pública.');
  }

  const html = await resp.text();
  const options: MediaOption[] = [];
  const seenUrls = new Set<string>();

  const videoMatches = html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
  for (const m of videoMatches) {
    const clean = unescapeEmbeddedUrl(m[1]);
    if (clean.startsWith('http') && !seenUrls.has(clean)) {
      seenUrls.add(clean);
      const token = cacheMediaTarget(clean, { Referer: 'https://www.instagram.com/' });
      options.push({
        id: `ig-vid-${options.length + 1}`,
        label: `Video / Reel MP4 #${options.length + 1}`,
        format: 'mp4',
        quality: 'MP4 Original',
        resolution: 'HD',
        url: token,
        filename: sanitizeFilename(`instagram_${shortcode}_${options.length + 1}`, 'mp4'),
        canConvertMp3: true,
      });
    }
  }

  const imgMatches = html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g);
  for (const m of imgMatches) {
    const clean = unescapeEmbeddedUrl(m[1]);
    if (clean.startsWith('http') && !seenUrls.has(clean)) {
      seenUrls.add(clean);
      const token = cacheMediaTarget(clean, { Referer: 'https://www.instagram.com/' });
      options.push({
        id: `ig-img-${options.length + 1}`,
        label: `Imagen de Publicación #${options.length + 1}`,
        format: 'jpg',
        quality: 'Alta Resolución',
        url: token,
        filename: sanitizeFilename(`instagram_${shortcode}_${options.length + 1}`, 'jpg'),
      });
    }
  }

  let previewThumb = '';
  const firstDisplay = html.match(/"display_url"\s*:\s*"([^"]+)"/);
  if (firstDisplay?.[1]) previewThumb = unescapeEmbeddedUrl(firstDisplay[1]);

  if (options.length === 0) {
    const fallbackImg = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);
    if (fallbackImg?.[1]) {
      const clean = unescapeEmbeddedUrl(fallbackImg[1]);
      previewThumb = clean;
      const token = cacheMediaTarget(clean, { Referer: 'https://www.instagram.com/' });
      options.push({
        id: 'ig-img-1',
        label: 'Imagen de Instagram',
        format: 'jpg',
        quality: 'JPG',
        url: token,
        filename: sanitizeFilename(`instagram_${shortcode}`, 'jpg'),
      });
    }
  }

  const authorMatch = html.match(/class="UsernameText"[^>]*>([^<]+)</i);
  const captionMatch = html.match(/class="Caption"[^>]*>[\s\S]*?<\/a>([^<]+)/i);
  const author = authorMatch?.[1]?.trim() ? `@${authorMatch[1].trim()}` : 'Instagram';
  const title = captionMatch?.[1]?.trim() || `Publicación de Instagram (${shortcode})`;

  if (options.length === 0) {
    throw new Error(
      'No se encontraron imágenes o videos públicos en este enlace. Es posible que la cuenta sea privada o requiera inicio de sesión.'
    );
  }

  return {
    platform: 'instagram',
    title,
    author,
    thumbnail: previewThumb,
    options,
  };
}

async function inspectFacebook(rawUrl: string): Promise<InspectResult> {
  const resp = await fetch(rawUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error('Facebook no permitió leer el video. Asegúrate de que sea público.');
  }

  const html = await resp.text();
  const options: MediaOption[] = [];
  const seen = new Set<string>();

  const hdPatterns = [
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/,
    /hd_src\s*:\s*"([^"]+)"/,
  ];
  for (const pat of hdPatterns) {
    const m = html.match(pat);
    if (m?.[1]) {
      const clean = unescapeEmbeddedUrl(m[1]);
      if (clean.startsWith('http') && !seen.has(clean)) {
        seen.add(clean);
        const token = cacheMediaTarget(clean, { Referer: 'https://www.facebook.com/' });
        options.push({
          id: 'fb-hd',
          label: 'Video MP4 Alta Definición (720p HD)',
          format: 'mp4',
          quality: '720p HD',
          resolution: '720p',
          url: token,
          filename: sanitizeFilename(`facebook_720p_${Date.now()}`, 'mp4'),
          canConvertMp3: true,
        });
        break;
      }
    }
  }

  const sdPatterns = [
    /"playable_url"\s*:\s*"([^"]+)"/,
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/,
    /sd_src\s*:\s*"([^"]+)"/,
    /<meta\s+property="og:video(?::url)?"\s+content="([^"]+)"/i,
  ];
  for (const pat of sdPatterns) {
    const m = html.match(pat);
    if (m?.[1]) {
      const clean = unescapeEmbeddedUrl(m[1]);
      if (clean.startsWith('http') && !seen.has(clean)) {
        seen.add(clean);
        const token = cacheMediaTarget(clean, { Referer: 'https://www.facebook.com/' });
        options.push({
          id: 'fb-sd',
          label: 'Video MP4 Estándar (480p SD)',
          format: 'mp4',
          quality: '480p SD',
          resolution: '480p',
          url: token,
          filename: sanitizeFilename(`facebook_480p_${Date.now()}`, 'mp4'),
          canConvertMp3: true,
        });
        break;
      }
    }
  }

  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1];
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1];

  if (options.length === 0) {
    throw new Error(
      'No se encontró un flujo de video público en este enlace de Facebook (puede ser privado o protegido).'
    );
  }

  return {
    platform: 'facebook',
    title: ogTitle ? unescapeEmbeddedUrl(ogTitle) : 'Video de Facebook',
    author: 'Facebook',
    thumbnail: ogImg ? unescapeEmbeddedUrl(ogImg) : '',
    options,
  };
}

async function inspectDirectMedia(parsed: URL): Promise<InspectResult> {
  let contentType = '';
  let sizeBytes: number | undefined;

  try {
    const head = await fetch(parsed.toString(), {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(5500),
    });
    if (head.ok) {
      contentType = head.headers.get('content-type') || '';
      const len = head.headers.get('content-length');
      if (len) sizeBytes = parseInt(len, 10) || undefined;
    } else if (head.status === 405 || head.status === 403) {
      const probe = await fetch(parsed.toString(), {
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(5500),
      });
      contentType = probe.headers.get('content-type') || '';
      await probe.body?.cancel();
    }
  } catch {
    throw new Error('No se pudo conectar con la URL proporcionada para verificar el archivo.');
  }

  if (contentType && isNonMediaContentType(contentType)) {
    throw new Error(
      'Este enlace apunta a una página web HTML y no a un archivo de video o audio directo (.mp4, .mp3, .m4a, .webm). Pega una URL de YouTube, TikTok, Facebook, Instagram o un archivo multimedia directo.'
    );
  }

  const ext = path.extname(parsed.pathname).replace('.', '').toLowerCase();
  let format: MediaOption['format'] = 'mp4';
  if (contentType.includes('audio/mpeg') || ext === 'mp3') format = 'mp3';
  else if (contentType.includes('audio/mp4') || ext === 'm4a') format = 'm4a';
  else if (contentType.includes('video/webm') || ext === 'webm') format = 'webm';
  else if (contentType.includes('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) format = 'jpg';

  const baseTitle = path.basename(parsed.pathname, `.${ext}`) || 'Archivo Multimedia Directo';
  return {
    platform: 'direct',
    title: baseTitle,
    author: parsed.hostname,
    thumbnail: format === 'jpg' ? parsed.toString() : '',
    options: [
      {
        id: 'direct-1',
        label: `Archivo Directo (${format.toUpperCase()})`,
        format,
        quality: 'Original',
        resolution: 'Original',
        url: parsed.toString(),
        filename: sanitizeFilename(baseTitle, format),
        sizeBytes,
        canConvertMp3: format !== 'jpg' && format !== 'mp3',
      },
    ],
  };
}

app.post('/api/media/inspect', async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Pega un enlace válido para analizar.' });
      return;
    }
    const initialParsed = validateExternalUrl(rawUrl);
    const parsed = await resolveRedirectIfNeeded(initialParsed);
    const platform = detectPlatform(parsed.toString());

    let result: InspectResult;
    if (platform === 'tiktok') {
      try {
        result = await inspectTikTok(parsed.toString());
      } catch {
        result = await inspectTikTokViaNotube(parsed.toString());
      }
    } else if (platform === 'youtube') {
      result = await inspectYouTube(parsed.toString());
    } else if (platform === 'instagram') {
      result = await inspectInstagram(parsed.toString());
    } else if (platform === 'facebook') {
      result = await inspectFacebook(parsed.toString());
    } else {
      result = await inspectDirectMedia(parsed);
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'No se pudo analizar el enlace proporcionado.',
    });
  }
});

async function fetchUrlToFile(
  targetUrl: string,
  extraHeaders: Record<string, string>,
  outPath: string,
  maxBytes = 200 * 1024 * 1024
): Promise<{ contentType: string; sizeBytes: number }> {
  const isYoutubeCdn = targetUrl.includes('googlevideo.com');
  const resp = await fetch(targetUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      ...(isYoutubeCdn ? { Range: `bytes=0-${maxBytes - 1}` } : {}),
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`El servidor remoto respondió con código ${resp.status}.`);
  }
  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  if (isNonMediaContentType(contentType)) {
    throw new Error('El origen devolvió una página web en lugar de un flujo multimedia.');
  }
  const arrayBuf = await resp.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new Error('El archivo supera el límite máximo permitido.');
  }
  const buf = Buffer.from(arrayBuf);
  if (buf.byteLength < 256 || bufferLooksLikeTextMarkup(buf)) {
    throw new Error('El enlace no entregó datos de audio o video válidos.');
  }
  fs.writeFileSync(outPath, buf);
  return { contentType, sizeBytes: buf.byteLength };
}

function runFfmpegMuxMp4(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  audioCodec: 'copy' | 'aac' = 'copy'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-c:v',
      'copy',
      '-c:a',
      audioCodec,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      outputPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    ff.on('error', (err) => reject(err));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(stderr));
      }
    });
  });
}

app.get('/api/media/proxy-download', async (req: Request, res: Response) => {
  const tempFiles: string[] = [];
  const cleanup = () => {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  };

  try {
    const rawSource = String(req.query.url || '').trim();
    const rawName = String(req.query.filename || 'descarga').trim();
    if (!rawSource) {
      res.status(400).json({ error: 'Falta la URL o token de descarga.' });
      return;
    }

    const { url: targetUrl, audioUrl, headers: extraHeaders } = await resolveMediaSourceAsync(rawSource);

    // If this token pairs adaptive HD video + audio, mux cleanly into a playable MP4
    if (audioUrl) {
      const vidPath = path.join(TEMP_DIR, `vid_${crypto.randomUUID()}.mp4`);
      const audPath = path.join(TEMP_DIR, `aud_${crypto.randomUUID()}.m4a`);
      const outPath = path.join(TEMP_DIR, `mux_${crypto.randomUUID()}.mp4`);
      tempFiles.push(vidPath, audPath, outPath);

      await Promise.all([
        fetchUrlToFile(targetUrl, extraHeaders, vidPath),
        fetchUrlToFile(audioUrl, extraHeaders, audPath),
      ]);

      try {
        await runFfmpegMuxMp4(vidPath, audPath, outPath, 'copy');
      } catch {
        await runFfmpegMuxMp4(vidPath, audPath, outPath, 'aac');
      }

      const stat = fs.statSync(outPath);
      const safeName = sanitizeFilename(rawName, 'mp4');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

      const stream = fs.createReadStream(outPath);
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      stream.pipe(res);
      return;
    }

    const isYoutubeCdn = targetUrl.includes('googlevideo.com');
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        ...(isYoutubeCdn ? { Range: 'bytes=0-199999999' } : {}),
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(90000),
    });

    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `El servidor de origen respondió con código ${upstream.status}.` });
      return;
    }

    const rawContentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (isNonMediaContentType(rawContentType)) {
      res.status(400).json({
        error: 'El enlace devolvió una página web en lugar de un archivo descargable.',
      });
      return;
    }

    const lowerName = rawName.toLowerCase();
    const contentLength = upstream.headers.get('content-length');
    const ext = rawContentType.includes('image/jpeg')
      ? 'jpg'
      : rawContentType.includes('image/png')
      ? 'png'
      : rawContentType.includes('audio/mpeg') || lowerName.endsWith('.mp3')
      ? 'mp3'
      : rawContentType.includes('audio/mp4') || lowerName.endsWith('.m4a')
      ? 'm4a'
      : 'mp4';

    const resolvedContentType =
      rawContentType === 'application/octet-stream'
        ? ext === 'mp3'
          ? 'audio/mpeg'
          : ext === 'm4a'
          ? 'audio/mp4'
          : ext === 'jpg'
          ? 'image/jpeg'
          : 'video/mp4'
        : rawContentType;

    const safeName = sanitizeFilename(rawName, ext);
    res.setHeader('Content-Type', resolvedContentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    };
    await pump();
  } catch (err) {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Error al descargar el archivo.' });
    }
  }
});

function extractCleanFfmpegError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = [...lines]
    .reverse()
    .find(
      (l) =>
        !l.startsWith('lib') &&
        !l.startsWith('configuration:') &&
        !l.startsWith('built with') &&
        !l.startsWith('ffmpeg version')
    );
  if (meaningful?.includes('Invalid data found')) {
    return 'El archivo o enlace no contiene una pista de audio/video válida que FFmpeg pueda decodificar.';
  }
  return meaningful ? `No se pudo convertir el audio a MP3 (${meaningful.slice(0, 140)}).` : 'FFmpeg no pudo convertir este archivo a MP3.';
}

function runFfmpegToMp3(inputPath: string, outputPath: string, bitrate: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const allowedBitrates = new Set(['128k', '192k', '320k']);
    const safeBitrate = allowedBitrates.has(bitrate) ? bitrate : '192k';
    const ff = spawn('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      safeBitrate,
      '-f',
      'mp3',
      outputPath,
    ]);

    let stderr = '';
    ff.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    ff.on('error', (err) => reject(err));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(extractCleanFfmpegError(stderr)));
      }
    });
  });
}

app.post('/api/media/convert-mp3', upload.single('file'), async (req: Request, res: Response) => {
  const tempFiles: string[] = [];
  const cleanup = () => {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  };

  try {
    const bitrate = String(req.body?.bitrate || '192k');
    let inputPath = '';
    let baseName = 'audio_convertido';

    if (req.file) {
      inputPath = req.file.path;
      tempFiles.push(inputPath);
      baseName = path.basename(req.file.originalname, path.extname(req.file.originalname)) || 'audio_convertido';
    } else if (req.body?.url) {
      const rawSource = String(req.body.url).trim();
      const { url: targetUrl, headers: extraHeaders } = await resolveMediaSourceAsync(rawSource);
      baseName = String(req.body?.filename || 'audio_convertido');

      inputPath = path.join(TEMP_DIR, `in_${crypto.randomUUID()}.bin`);
      tempFiles.push(inputPath);
      await fetchUrlToFile(targetUrl, extraHeaders, inputPath, 150 * 1024 * 1024);
    } else {
      res.status(400).json({ error: 'Sube un archivo de video/audio o indica una URL directa.' });
      return;
    }

    const outputPath = path.join(TEMP_DIR, `out_${crypto.randomUUID()}.mp3`);
    tempFiles.push(outputPath);

    await runFfmpegToMp3(inputPath, outputPath, bitrate);

    const stat = fs.statSync(outputPath);
    const outName = sanitizeFilename(baseName, 'mp3');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);

    const stream = fs.createReadStream(outputPath);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    stream.pipe(res);
  } catch (err) {
    cleanup();
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Error al convertir el audio a MP3.',
    });
  }
});

// Ensure /api/* errors always return JSON rather than plain HTML error pages
app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    error: err instanceof Error ? err.message : 'Error interno en el servidor multimedia.',
  });
});

async function startServer() {
  const distDir = path.resolve(process.cwd(), 'dist');
  const distIndexExists = fs.existsSync(path.join(distDir, 'index.html'));
  const isDevMode =
    process.env.DISABLE_HMR === 'true' ||
    process.env.npm_lifecycle_event === 'dev' ||
    (process.env.NODE_ENV !== 'production' && !distIndexExists);

  if (isDevMode) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EnlaceFlow server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
