import express from 'express';
import type { Request, Response } from 'express';
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
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
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
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) return 'facebook';
  } catch {
    // ignore
  }
  return 'direct';
}

interface MediaOption {
  id: string;
  label: string;
  format: 'mp4' | 'mp3' | 'jpg' | 'm4a' | 'webm';
  quality: string;
  url: string;
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
        { signal: AbortSignal.timeout(5000) }
      );
      if (oembedResp.ok) {
        const meta = (await oembedResp.json()) as { title?: string; author_name?: string };
        if (meta.title) title = meta.title;
        if (meta.author_name) author = meta.author_name;
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

async function inspectTikTok(rawUrl: string): Promise<InspectResult> {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(rawUrl)}&hd=1`;
  const resp = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) {
    throw new Error('No se pudo conectar con el extractor de TikTok.');
  }
  const json = (await resp.json()) as {
    code: number;
    msg?: string;
    data?: {
      title?: string;
      cover?: string;
      origin_cover?: string;
      duration?: number;
      play?: string;
      hdplay?: string;
      music?: string;
      size?: number;
      hd_size?: number;
      author?: { nickname?: string; unique_id?: string };
      images?: string[];
    };
  };

  if (json.code !== 0 || !json.data) {
    throw new Error(json.msg || 'No se encontró el video de TikTok o es privado.');
  }

  const d = json.data;
  const title = d.title?.trim() || 'Video de TikTok';
  const author = d.author?.nickname || (d.author?.unique_id ? `@${d.author.unique_id}` : 'TikTok');
  const options: MediaOption[] = [];

  if (d.hdplay) {
    options.push({
      id: 'tt-hd',
      label: 'Video HD Sin Marca de Agua',
      format: 'mp4',
      quality: 'HD MP4',
      url: d.hdplay,
      filename: sanitizeFilename(`${title}_tiktok_hd`, 'mp4'),
      sizeBytes: d.hd_size,
      noWatermark: true,
      canConvertMp3: true,
    });
  }
  if (d.play && d.play !== d.hdplay) {
    options.push({
      id: 'tt-sd',
      label: 'Video MP4 Sin Marca de Agua',
      format: 'mp4',
      quality: 'MP4 Estándar',
      url: d.play,
      filename: sanitizeFilename(`${title}_tiktok`, 'mp4'),
      sizeBytes: d.size,
      noWatermark: true,
      canConvertMp3: true,
    });
  }
  if (d.music) {
    options.push({
      id: 'tt-mp3',
      label: 'Audio Original Extraído',
      format: 'mp3',
      quality: 'MP3 Audio',
      url: d.music,
      filename: sanitizeFilename(`${title}_audio`, 'mp3'),
    });
  }
  if (Array.isArray(d.images)) {
    d.images.forEach((imgUrl, idx) => {
      options.push({
        id: `tt-img-${idx}`,
        label: `Imagen de Carrusel #${idx + 1}`,
        format: 'jpg',
        quality: 'JPG Original',
        url: imgUrl,
        filename: sanitizeFilename(`${title}_slide_${idx + 1}`, 'jpg'),
      });
    });
  }

  return {
    platform: 'tiktok',
    title,
    author,
    thumbnail: d.origin_cover || d.cover || '',
    durationSec: d.duration,
    options,
  };
}

async function inspectYouTube(rawUrl: string): Promise<InspectResult> {
  const videoId = extractYouTubeId(rawUrl);
  if (!videoId) {
    throw new Error('URL de YouTube no reconocida.');
  }

  let title = `YouTube Video (${videoId})`;
  let author = 'YouTube';
  let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembed = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (oembed.ok) {
      const meta = (await oembed.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      if (meta.title) title = meta.title;
      if (meta.author_name) author = meta.author_name;
      if (meta.thumbnail_url) thumbnail = meta.thumbnail_url;
    }
  } catch {
    // ignore
  }

  const options: MediaOption[] = [];
  let warning: string | undefined;
  let durationSec: number | undefined;

  try {
    const yt = await Innertube.create({ generate_session_locally: true });
    const info = await yt.getBasicInfo(videoId);
    if (info.basic_info.title) title = info.basic_info.title;
    if (info.basic_info.author) author = info.basic_info.author;
    if (info.basic_info.duration) durationSec = info.basic_info.duration;

    const streaming = info.streaming_data;
    if (streaming) {
      const combined = streaming.formats || [];
      for (const fmt of combined) {
        const directUrl = await fmt.decipher(yt.session.player);
        if (directUrl) {
          options.push({
            id: `yt-fmt-${fmt.itag}`,
            label: `Video MP4 (${fmt.quality_label || 'Estándar'})`,
            format: 'mp4',
            quality: fmt.quality_label || 'MP4',
            url: directUrl,
            filename: sanitizeFilename(`${title}_${fmt.quality_label || 'video'}`, 'mp4'),
            sizeBytes: fmt.content_length ? Number(fmt.content_length) : undefined,
            canConvertMp3: true,
          });
        }
      }
      const audioFormats = (streaming.adaptive_formats || []).filter((f) =>
        String(f.mime_type || '').startsWith('audio/')
      );
      if (audioFormats.length > 0) {
        const bestAudio = audioFormats[0];
        const audioUrl = await bestAudio.decipher(yt.session.player);
        if (audioUrl) {
          options.push({
            id: `yt-audio-${bestAudio.itag}`,
            label: 'Pista de Audio (Convertible a MP3)',
            format: 'm4a',
            quality: `${Math.round((bestAudio.bitrate || 128000) / 1000)} kbps`,
            url: audioUrl,
            filename: sanitizeFilename(`${title}_audio`, 'm4a'),
            sizeBytes: bestAudio.content_length ? Number(bestAudio.content_length) : undefined,
            canConvertMp3: true,
          });
        }
      }
    }
  } catch {
    warning =
      'YouTube restringió la extracción directa del flujo desde esta IP de servidor. Puedes descargar todas las miniaturas HD al instante o convertir a MP3 subiendo el archivo en la pestaña Conversor MP3.';
  }

  if (options.length === 0 && !warning) {
    warning =
      'YouTube no devolvió flujos directos descargables para este enlace en este momento. Las miniaturas HD están disponibles.';
  }

  options.push({
    id: `yt-thumb-${videoId}`,
    label: 'Miniatura HD del Video',
    format: 'jpg',
    quality: '1280×720 / HQ',
    url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    filename: sanitizeFilename(`${title}_miniatura`, 'jpg'),
  });

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
  const match = rawUrl.match(/instagram\.com\/(?:p|reel|tv)\/([a-zA-Z0-9_-]+)/i);
  if (!match) {
    throw new Error('Ingresa un enlace válido de publicación o Reel de Instagram (/p/ o /reel/).');
  }
  const shortcode = match[1];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(10000),
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
      options.push({
        id: `ig-vid-${options.length + 1}`,
        label: `Video / Reel #${options.length + 1}`,
        format: 'mp4',
        quality: 'MP4 Original',
        url: clean,
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
      options.push({
        id: `ig-img-${options.length + 1}`,
        label: `Imagen de Publicación #${options.length + 1}`,
        format: 'jpg',
        quality: 'Alta Resolución',
        url: clean,
        filename: sanitizeFilename(`instagram_${shortcode}_${options.length + 1}`, 'jpg'),
      });
    }
  }

  // Fallback to EmbeddedMediaImage in embed HTML
  if (options.length === 0) {
    const fallbackImg = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);
    if (fallbackImg && fallbackImg[1]) {
      const clean = unescapeEmbeddedUrl(fallbackImg[1]);
      options.push({
        id: 'ig-img-1',
        label: 'Imagen de Instagram',
        format: 'jpg',
        quality: 'JPG',
        url: clean,
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
      'No se encontraron imágenes o videos públicos en este enlace. Es posible que la cuenta sea privada o requiera sesión.'
    );
  }

  return {
    platform: 'instagram',
    title,
    author,
    thumbnail: options.find((o) => o.format === 'jpg')?.url || '',
    options,
  };
}

async function inspectFacebook(rawUrl: string): Promise<InspectResult> {
  const resp = await fetch(rawUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
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
        options.push({
          id: 'fb-hd',
          label: 'Video Facebook HD',
          format: 'mp4',
          quality: 'HD MP4',
          url: clean,
          filename: sanitizeFilename(`facebook_hd_${Date.now()}`, 'mp4'),
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
        options.push({
          id: 'fb-sd',
          label: 'Video Facebook Estándar',
          format: 'mp4',
          quality: 'SD MP4',
          url: clean,
          filename: sanitizeFilename(`facebook_sd_${Date.now()}`, 'mp4'),
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

app.post('/api/media/inspect', async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Pega un enlace válido para analizar.' });
      return;
    }
    const parsed = validateExternalUrl(rawUrl);
    const platform = detectPlatform(parsed.toString());

    let result: InspectResult;
    if (platform === 'tiktok') {
      result = await inspectTikTok(parsed.toString());
    } else if (platform === 'youtube') {
      result = await inspectYouTube(parsed.toString());
    } else if (platform === 'instagram') {
      result = await inspectInstagram(parsed.toString());
    } else if (platform === 'facebook') {
      result = await inspectFacebook(parsed.toString());
    } else {
      const ext = path.extname(parsed.pathname).replace('.', '').toLowerCase();
      const format = (['mp4', 'mp3', 'jpg', 'm4a', 'webm'].includes(ext) ? ext : 'mp4') as MediaOption['format'];
      result = {
        platform: 'direct',
        title: path.basename(parsed.pathname) || 'Archivo Multimedia Directo',
        author: parsed.hostname,
        thumbnail: format === 'jpg' ? parsed.toString() : '',
        options: [
          {
            id: 'direct-1',
            label: `Archivo Directo (${format.toUpperCase()})`,
            format,
            quality: 'Original',
            url: parsed.toString(),
            filename: sanitizeFilename(path.basename(parsed.pathname, `.${ext}`) || 'media', format),
            canConvertMp3: format !== 'jpg' && format !== 'mp3',
          },
        ],
      };
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'No se pudo analizar el enlace proporcionado.',
    });
  }
});

app.get('/api/media/proxy-download', async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const rawName = String(req.query.filename || 'descarga').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Falta la URL de descarga.' });
      return;
    }
    const parsed = validateExternalUrl(rawUrl);

    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `El servidor de origen respondió con código ${upstream.status}.` });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const ext = contentType.includes('image/jpeg')
      ? 'jpg'
      : contentType.includes('image/png')
      ? 'png'
      : contentType.includes('audio/mpeg')
      ? 'mp3'
      : 'mp4';

    const safeName = sanitizeFilename(rawName, ext);
    res.setHeader('Content-Type', contentType);
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
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Error al descargar el archivo.' });
    }
  }
});

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
        reject(new Error(`FFmpeg falló al convertir a MP3: ${stderr.slice(-240)}`));
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
      const parsed = validateExternalUrl(String(req.body.url));
      baseName = String(req.body?.filename || path.basename(parsed.pathname, path.extname(parsed.pathname)) || 'audio_convertido');
      const dlResp = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(45000),
      });
      if (!dlResp.ok || !dlResp.body) {
        throw new Error('No se pudo descargar el medio remoto para convertir a MP3.');
      }
      inputPath = path.join(TEMP_DIR, `in_${crypto.randomUUID()}.bin`);
      tempFiles.push(inputPath);
      const arrayBuf = await dlResp.arrayBuffer();
      if (arrayBuf.byteLength > 150 * 1024 * 1024) {
        throw new Error('El archivo supera el límite máximo de 150 MB.');
      }
      fs.writeFileSync(inputPath, Buffer.from(arrayBuf));
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

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
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
