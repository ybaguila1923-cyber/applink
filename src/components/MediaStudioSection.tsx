import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  FileAudio,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  DownloadQueueItem,
  MediaInspectResult,
  MediaOption,
  MediaPlatform,
  YouTubeThumbnailResult,
} from '../types/app';

type MediaToolTab = 'social' | 'thumbnails' | 'mp3';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function platformDisplayName(platform: MediaPlatform | 'mp3-converter'): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube';
    case 'tiktok':
      return 'TikTok';
    case 'instagram':
      return 'Instagram';
    case 'facebook':
      return 'Facebook';
    case 'mp3-converter':
      return 'Conversor MP3';
    default:
      return 'Enlace directo';
  }
}

function triggerBrowserSave(blobUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function extractClientYouTubeId(rawUrl: string): string | null {
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

async function safeReadJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (resp.status === 404) {
      throw new Error(
        'El servicio de servidor para descargas (/api/media) no está activo en este enlace externo (HTTP 404). Abre la vista previa completa con servidor activo o vuelve a publicar la aplicación para procesar MP4 y MP3.'
      );
    }
    throw new Error(
      resp.ok
        ? 'El servidor devolvió una respuesta inesperada. Inténtalo de nuevo.'
        : `El servidor no pudo procesar el enlace (HTTP ${resp.status}). Verifica que el enlace sea público o inténtalo nuevamente.`
    );
  }
}

type PreferredVideoSize = 'best' | '1080p' | '720p' | '480p' | '360p';

function pickPreferredVideoOption(
  options: MediaOption[],
  preferred: PreferredVideoSize
): MediaOption | null {
  const videoOptions = options.filter((o) => o.format === 'mp4' || o.format === 'webm');
  if (videoOptions.length === 0) return null;
  if (preferred === 'best') return videoOptions[0];
  const exact = videoOptions.find(
    (o) =>
      o.resolution?.toLowerCase() === preferred ||
      o.quality.toLowerCase().includes(preferred)
  );
  if (exact) return exact;
  const targetNum = parseInt(preferred, 10) || 720;
  const sorted = [...videoOptions].sort((a, b) => {
    const aNum = parseInt(a.resolution || a.quality || '720', 10) || 720;
    const bNum = parseInt(b.resolution || b.quality || '720', 10) || 720;
    return Math.abs(aNum - targetNum) - Math.abs(bNum - targetNum);
  });
  return sorted[0];
}

export function MediaStudioSection() {
  const [activeTab, setActiveTab] = useState<MediaToolTab>('social');

  // Social Downloader state
  const [socialUrl, setSocialUrl] = useState('');
  const [preferredSize, setPreferredSize] = useState<PreferredVideoSize>('best');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<MediaInspectResult | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  // YouTube Thumbnails state
  const [ytThumbUrl, setYtThumbUrl] = useState('');
  const [loadingThumbs, setLoadingThumbs] = useState(false);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [thumbResult, setThumbResult] = useState<YouTubeThumbnailResult | null>(null);

  // MP3 Converter state
  const [mp3Mode, setMp3Mode] = useState<'file' | 'url'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mp3Url, setMp3Url] = useState('');
  const [mp3Bitrate, setMp3Bitrate] = useState<'128k' | '192k' | '320k'>('192k');
  const [convertingMp3, setConvertingMp3] = useState(false);
  const [mp3Error, setMp3Error] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Unified Download Queue
  const [queue, setQueue] = useState<DownloadQueueItem[]>([]);
  const [queueFilter, setQueueFilter] = useState<'all' | 'active' | 'completed'>('all');

  const updateQueueItem = (id: string, patch: Partial<DownloadQueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const enqueueProxyDownload = async (
    title: string,
    platform: MediaPlatform,
    format: string,
    quality: string,
    sourceUrl: string,
    filename: string,
    expectedSize?: number
  ) => {
    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();

    const newItem: DownloadQueueItem = {
      id,
      title,
      platform,
      format: format.toUpperCase(),
      quality,
      filename,
      status: 'downloading',
      progressPct: 0,
      bytesLoaded: 0,
      bytesTotal: expectedSize,
      createdAt: Date.now(),
      sourceUrl,
      abortController: controller,
    };

    setQueue((prev) => [newItem, ...prev]);

    try {
      const endpoint = `/api/media/proxy-download?url=${encodeURIComponent(
        sourceUrl
      )}&filename=${encodeURIComponent(filename)}`;

      const resp = await fetch(endpoint, { signal: controller.signal });
      if (!resp.ok) {
        let msg = `Error HTTP ${resp.status}`;
        try {
          const errJson = (await resp.json()) as { error?: string };
          if (errJson.error) msg = errJson.error;
        } catch {
          if (resp.status === 404) {
            msg =
              'El servicio de servidor (/api/media) no está activo en este enlace externo (HTTP 404). Abre la vista previa completa con servidor activo.';
          }
        }
        throw new Error(msg);
      }

      const contentLen = Number(resp.headers.get('content-length') || expectedSize || 0);
      const reader = resp.body?.getReader();

      if (!reader) {
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        updateQueueItem(id, {
          status: 'completed',
          progressPct: 100,
          bytesLoaded: blob.size,
          bytesTotal: blob.size,
          blobUrl,
        });
        triggerBrowserSave(blobUrl, filename);
        return;
      }

      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          const pct =
            contentLen > 0 ? Math.min(99, Math.round((loaded / contentLen) * 100)) : 50;
          updateQueueItem(id, {
            bytesLoaded: loaded,
            bytesTotal: contentLen || undefined,
            progressPct: pct,
          });
        }
      }

      const blobParts = chunks.map((chunk) => new Uint8Array(chunk));
      const blob = new Blob(blobParts, {
        type: resp.headers.get('content-type') || 'application/octet-stream',
      });
      const blobUrl = URL.createObjectURL(blob);

      updateQueueItem(id, {
        status: 'completed',
        progressPct: 100,
        bytesLoaded: blob.size,
        bytesTotal: blob.size,
        blobUrl,
      });

      triggerBrowserSave(blobUrl, filename);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        updateQueueItem(id, { status: 'cancelled' });
        return;
      }
      updateQueueItem(id, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Fallo durante la descarga.',
      });
    }
  };

  const enqueueMp3FromUrl = async (
    title: string,
    sourceUrl: string,
    filename: string,
    bitrate: '128k' | '192k' | '320k'
  ) => {
    const id = `mp3_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();
    const mp3Filename = filename.replace(/\.[^.]+$/, '') + '.mp3';

    setQueue((prev) => [
      {
        id,
        title,
        platform: 'mp3-converter',
        format: 'MP3',
        quality: bitrate,
        filename: mp3Filename,
        status: 'converting',
        progressPct: 35,
        bytesLoaded: 0,
        createdAt: Date.now(),
        sourceUrl,
        abortController: controller,
      },
      ...prev,
    ]);

    try {
      const resp = await fetch('/api/media/convert-mp3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, bitrate, filename: mp3Filename }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        let msg = 'No se pudo convertir el audio a MP3.';
        try {
          const errData = await safeReadJson<{ error?: string }>(resp);
          if (errData.error) msg = errData.error;
        } catch (parseErr) {
          if (parseErr instanceof Error) msg = parseErr.message;
        }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      updateQueueItem(id, {
        status: 'completed',
        progressPct: 100,
        bytesLoaded: blob.size,
        bytesTotal: blob.size,
        blobUrl,
      });
      triggerBrowserSave(blobUrl, mp3Filename);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        updateQueueItem(id, { status: 'cancelled' });
        return;
      }
      updateQueueItem(id, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Error en la conversión a MP3.',
      });
    }
  };

  const handleInspectSocial = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = socialUrl.trim();
    if (!trimmed) return;

    setInspecting(true);
    setInspectError(null);
    setInspectResult(null);
    setThumbFailed(false);

    try {
      const resp = await fetch('/api/media/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await safeReadJson<MediaInspectResult & { error?: string }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || 'No se pudo analizar la publicación.');
      }
      setInspectResult(data);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Error al consultar la URL.');
    } finally {
      setInspecting(false);
    }
  };

  const handleFetchYouTubeThumbs = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = ytThumbUrl.trim();
    if (!trimmed) return;

    setLoadingThumbs(true);
    setThumbError(null);
    setThumbResult(null);

    try {
      const resp = await fetch(`/api/media/thumbnails?url=${encodeURIComponent(trimmed)}`);
      if (resp.status === 404) {
        const videoId = extractClientYouTubeId(trimmed);
        if (!videoId) {
          throw new Error('Ingresa una URL válida de YouTube (watch, shorts o youtu.be).');
        }
        let title = `YouTube ${videoId}`;
        let author = 'Canal de YouTube';
        try {
          const oe = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(
              `https://www.youtube.com/watch?v=${videoId}`
            )}&format=json`
          );
          if (oe.ok) {
            const meta = (await oe.json()) as { title?: string; author_name?: string };
            if (meta.title) title = meta.title;
            if (meta.author_name) author = meta.author_name;
          }
        } catch {
          // ignore oembed failure
        }
        const variants = [
          { key: 'maxresdefault', label: 'Full HD (MaxRes)', width: 1280, height: 720 },
          { key: 'sddefault', label: 'Estándar HD (SD)', width: 640, height: 480 },
          { key: 'hqdefault', label: 'Alta Calidad (HQ)', width: 480, height: 360 },
          { key: 'mqdefault', label: 'Media (MQ)', width: 320, height: 180 },
          { key: 'default', label: 'Miniatura Compacta', width: 120, height: 90 },
        ];
        setThumbResult({
          videoId,
          title,
          author,
          thumbnails: variants.map((v) => ({
            ...v,
            url: `https://i.ytimg.com/vi/${videoId}/${v.key}.jpg`,
            available: true,
            sizeBytes: 0,
            filename: `${title.replace(/[^a-zA-Z0-9._\-\s]/g, '').trim().replace(/\s+/g, '_') || videoId}_${v.key}.jpg`,
          })),
        });
        return;
      }
      const data = await safeReadJson<YouTubeThumbnailResult & { error?: string }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || 'No se pudieron extraer las miniaturas.');
      }
      setThumbResult(data);
    } catch (err) {
      setThumbError(err instanceof Error ? err.message : 'Error al procesar URL de YouTube.');
    } finally {
      setLoadingThumbs(false);
    }
  };

  const handleConvertMp3Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMp3Error(null);

    if (mp3Mode === 'file') {
      if (!selectedFile) {
        setMp3Error('Selecciona o arrastra un archivo de video o audio primero.');
        return;
      }
      const id = `mp3_${Date.now()}`;
      const controller = new AbortController();
      const outName =
        (selectedFile.name.replace(/\.[^.]+$/, '') || 'audio') + '.mp3';

      setConvertingMp3(true);
      setQueue((prev) => [
        {
          id,
          title: selectedFile.name,
          platform: 'mp3-converter',
          format: 'MP3',
          quality: mp3Bitrate,
          filename: outName,
          status: 'converting',
          progressPct: 45,
          bytesLoaded: 0,
          bytesTotal: selectedFile.size,
          createdAt: Date.now(),
          abortController: controller,
        },
        ...prev,
      ]);

      try {
        const form = new FormData();
        form.append('file', selectedFile);
        form.append('bitrate', mp3Bitrate);

        const resp = await fetch('/api/media/convert-mp3', {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });

        if (!resp.ok) {
          let msg = 'Error al convertir el archivo.';
          try {
            const errData = await safeReadJson<{ error?: string }>(resp);
            if (errData.error) msg = errData.error;
          } catch (parseErr) {
            if (parseErr instanceof Error) msg = parseErr.message;
          }
          throw new Error(msg);
        }

        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        updateQueueItem(id, {
          status: 'completed',
          progressPct: 100,
          bytesLoaded: blob.size,
          bytesTotal: blob.size,
          blobUrl,
        });
        triggerBrowserSave(blobUrl, outName);
        setSelectedFile(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          updateQueueItem(id, { status: 'cancelled' });
        } else {
          const msg = err instanceof Error ? err.message : 'Error al convertir a MP3.';
          setMp3Error(msg);
          updateQueueItem(id, { status: 'error', errorMessage: msg });
        }
      } finally {
        setConvertingMp3(false);
      }
    } else {
      const trimmed = mp3Url.trim();
      if (!trimmed) {
        setMp3Error('Pega la URL de un video para extraer su audio en MP3.');
        return;
      }
      setConvertingMp3(true);
      try {
        const inspectResp = await fetch('/api/media/inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        });
        const info = await safeReadJson<MediaInspectResult & { error?: string }>(inspectResp);
        if (!inspectResp.ok) {
          throw new Error(info.error || 'No se pudo leer el enlace de video.');
        }
        const directMp3 = info.options.find((o) => o.format === 'mp3');
        if (directMp3) {
          await enqueueProxyDownload(
            info.title,
            info.platform,
            'MP3',
            'Audio Original',
            directMp3.url,
            directMp3.filename,
            directMp3.sizeBytes
          );
        } else {
          const candidate =
            info.options.find((o) => o.format === 'm4a') ||
            info.options.find((o) => o.audioSourceUrl) ||
            info.options.find((o) => o.format === 'mp4' || o.format === 'webm');
          if (!candidate) {
            throw new Error(
              info.warning ||
                'No hay flujo de audio/video directo disponible desde este enlace. Prueba subiendo el archivo en la pestaña "Subir archivo de video".'
            );
          }
          await enqueueMp3FromUrl(
            info.title,
            candidate.audioSourceUrl || candidate.url,
            info.title,
            mp3Bitrate
          );
        }
        setMp3Url('');
      } catch (err) {
        setMp3Error(err instanceof Error ? err.message : 'No se pudo convertir el enlace.');
      } finally {
        setConvertingMp3(false);
      }
    }
  };

  const filteredQueue = useMemo(() => {
    return queue.filter((item) => {
      if (queueFilter === 'active') {
        return item.status === 'downloading' || item.status === 'converting';
      }
      if (queueFilter === 'completed') {
        return item.status === 'completed';
      }
      return true;
    });
  }, [queue, queueFilter]);

  const matchedVideoOption = useMemo(() => {
    if (!inspectResult) return null;
    return pickPreferredVideoOption(inspectResult.options, preferredSize);
  }, [inspectResult, preferredSize]);

  const handleDownloadOption = (opt: MediaOption, res: MediaInspectResult) => {
    void enqueueProxyDownload(
      res.title,
      res.platform,
      opt.format,
      opt.noWatermark ? `${opt.quality} · Sin marca` : opt.quality,
      opt.url,
      opt.filename,
      opt.sizeBytes
    );
  };

  return (
    <div className="space-y-8 text-black">
      {/* Section Header + Tool Switcher */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-semibold text-black tracking-tight">
              Estudio de Descargas y Audio MP3
            </h1>
            <p className="text-[18px] text-black leading-relaxed">
              Descarga videos de TikTok sin marca de agua, Facebook, YouTube, imágenes de Instagram, miniaturas HD y convierte videos a MP3.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start md:self-auto overflow-x-auto max-w-full">
            <button
              type="button"
              onClick={() => setActiveTab('social')}
              className={`px-3.5 py-2 text-[18px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 text-black ${
                activeTab === 'social' ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
              }`}
            >
              Descargador Social
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('thumbnails')}
              className={`px-3.5 py-2 text-[18px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 text-black ${
                activeTab === 'thumbnails' ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
              }`}
            >
              Miniaturas YouTube
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('mp3')}
              className={`px-3.5 py-2 text-[18px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 text-black ${
                activeTab === 'mp3' ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
              }`}
            >
              Conversor a MP3
            </button>
          </div>
        </div>

        {/* Tool 1: Social Downloader */}
        {activeTab === 'social' && (
          <div className="space-y-5 pt-2 border-t border-slate-100">
            <form onSubmit={handleInspectSocial} className="space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label htmlFor="social-url-input" className="sr-only">
                    Pega el enlace de YouTube, TikTok, Facebook o Instagram
                  </label>
                  <input
                    id="social-url-input"
                    type="url"
                    required
                    placeholder="Pega aquí la URL de YouTube, TikTok, Facebook o Instagram…"
                    value={socialUrl}
                    onChange={(e) => setSocialUrl(e.target.value)}
                    className="w-full h-12 px-4 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={inspecting}
                  className="inline-flex items-center justify-center gap-2 h-12 px-5 text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  {inspecting ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="w-5 h-5" />
                  )}
                  Analizar enlace
                </button>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                <label htmlFor="preferred-mp4-size" className="text-[18px] font-medium text-black">
                  ¿Qué tamaño / resolución MP4 prefieres descargar?
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { key: 'best', label: 'Mejor disponible' },
                      { key: '1080p', label: '1080p Full HD' },
                      { key: '720p', label: '720p HD' },
                      { key: '480p', label: '480p SD' },
                      { key: '360p', label: '360p Ligero' },
                    ] as const
                  ).map((sz) => (
                    <button
                      key={sz.key}
                      type="button"
                      onClick={() => setPreferredSize(sz.key)}
                      className={`px-3 py-1.5 text-[18px] rounded-lg border transition-colors whitespace-nowrap ${
                        preferredSize === sz.key
                          ? 'bg-emerald-600 text-white border-emerald-600 font-medium'
                          : 'bg-slate-50 text-black border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {sz.label}
                    </button>
                  ))}
                </div>
              </div>
            </form>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[18px] text-black">
              <span>YouTube (Video MP4 / Audio)</span>
              <span aria-hidden="true">·</span>
              <span>TikTok (MP4 Sin marca de agua)</span>
              <span aria-hidden="true">·</span>
              <span>Instagram (Imágenes y Reels MP4)</span>
              <span aria-hidden="true">·</span>
              <span>Facebook (MP4 HD / SD)</span>
            </div>

            {inspectError && (
              <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-[18px] text-red-700 flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 shrink-0 mt-1" />
                <span>{inspectError}</span>
              </div>
            )}

            {inspectResult && (
              <div className="pt-4 border-t border-slate-200 grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                <div className="md:col-span-4 space-y-2.5">
                  <div className="aspect-video w-full rounded-lg overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center">
                    {inspectResult.thumbnail && !thumbFailed ? (
                      <img
                        src={inspectResult.thumbnail}
                        alt={inspectResult.title}
                        referrerPolicy="no-referrer"
                        onError={() => setThumbFailed(true)}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-1.5 text-black p-4 text-center">
                        <Film className="w-7 h-7" />
                        <span className="text-[18px]">{platformDisplayName(inspectResult.platform)}</span>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[18px] text-black">
                      <span>{platformDisplayName(inspectResult.platform)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{inspectResult.author}</span>
                      {inspectResult.durationSec ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {formatDuration(inspectResult.durationSec)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <h3 className="text-[18px] font-semibold text-black line-clamp-2">
                      {inspectResult.title}
                    </h3>
                  </div>
                </div>

                <div className="md:col-span-8 space-y-4">
                  {inspectResult.warning && (
                    <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-[18px] text-black space-y-3">
                      <p>{inspectResult.warning}</p>
                      {inspectResult.platform === 'youtube' && inspectResult.options.length === 0 && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setYtThumbUrl(socialUrl);
                              setActiveTab('thumbnails');
                            }}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-[18px] font-medium bg-white border border-slate-300 hover:bg-slate-100 text-black rounded-lg transition-colors"
                          >
                            <ImageIcon className="w-4 h-4" />
                            Ir a Miniaturas YouTube
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMp3Mode('file');
                              setActiveTab('mp3');
                            }}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-[18px] font-medium bg-white border border-slate-300 hover:bg-slate-100 text-black rounded-lg transition-colors"
                          >
                            <FileAudio className="w-4 h-4" />
                            Convertir archivo local a MP3
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {matchedVideoOption && (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="text-[18px] font-semibold text-black">
                          Tamaño seleccionado: {matchedVideoOption.resolution || matchedVideoOption.quality}
                          {matchedVideoOption.dimensions ? ` (${matchedVideoOption.dimensions})` : ''}
                        </p>
                        <p className="text-[18px] text-black">
                          Formato {matchedVideoOption.format.toUpperCase()}
                          {matchedVideoOption.sizeBytes ? ` · ${formatBytes(matchedVideoOption.sizeBytes)}` : ''}
                          {matchedVideoOption.noWatermark ? ' · Sin marca de agua' : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDownloadOption(matchedVideoOption, inspectResult)}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-[18px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        <ArrowDownToLine className="w-5 h-5" />
                        Descargar MP4 ({matchedVideoOption.resolution || matchedVideoOption.quality})
                      </button>
                    </div>
                  )}

                  {inspectResult.options.length > 0 && (
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                      {inspectResult.options.map((opt) => {
                        const isMatched = matchedVideoOption?.id === opt.id;
                        return (
                          <div
                            key={opt.id}
                            className={`px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                              isMatched ? 'bg-slate-50/80' : ''
                            }`}
                          >
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-[18px] font-medium text-black">{opt.label}</p>
                              <div className="flex flex-wrap items-center gap-2 text-[18px] text-black">
                                <span className="uppercase">{opt.format}</span>
                                <span aria-hidden="true">·</span>
                                <span>{opt.quality}</span>
                                {opt.dimensions && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">{opt.dimensions}</span>
                                  </>
                                )}
                                {opt.noWatermark && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-emerald-700 font-medium">Sin marca de agua</span>
                                  </>
                                )}
                                {opt.sizeBytes ? (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                      {formatBytes(opt.sizeBytes)}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {opt.canConvertMp3 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void enqueueMp3FromUrl(
                                      inspectResult.title,
                                      opt.audioSourceUrl || opt.url,
                                      inspectResult.title,
                                      mp3Bitrate
                                    )
                                  }
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-slate-100 hover:bg-slate-200 text-black rounded-lg transition-colors whitespace-nowrap"
                                >
                                  <Music className="w-4 h-4" />
                                  Extraer MP3
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDownloadOption(opt, inspectResult)}
                                className="inline-flex items-center gap-1.5 px-4 py-2 text-[18px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors whitespace-nowrap"
                              >
                                <ArrowDownToLine className="w-4 h-4" />
                                Descargar {opt.format.toUpperCase()}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tool 2: YouTube Thumbnail Downloader */}
        {activeTab === 'thumbnails' && (
          <div className="space-y-5 pt-2 border-t border-slate-100">
            <form onSubmit={handleFetchYouTubeThumbs} className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label htmlFor="yt-thumb-url" className="sr-only">
                  URL del video de YouTube
                </label>
                <input
                  id="yt-thumb-url"
                  type="url"
                  required
                  placeholder="Pega la URL del video o Short de YouTube…"
                  value={ytThumbUrl}
                  onChange={(e) => setYtThumbUrl(e.target.value)}
                  className="w-full h-12 px-4 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                />
              </div>
              <button
                type="submit"
                disabled={loadingThumbs}
                className="inline-flex items-center justify-center gap-2 h-12 px-5 text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {loadingThumbs ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <ImageIcon className="w-5 h-5" />
                )}
                Obtener miniaturas
              </button>
            </form>

            {thumbError && (
              <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-[18px] text-red-700 flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 shrink-0 mt-1" />
                <span>{thumbError}</span>
              </div>
            )}

            {thumbResult && (
              <div className="space-y-4 pt-2 border-t border-slate-100">
                <div className="space-y-1">
                  <p className="text-[18px] text-black">{thumbResult.author}</p>
                  <h3 className="text-xl font-semibold text-black">{thumbResult.title}</h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {thumbResult.thumbnails.map((t) => (
                    <div
                      key={t.key}
                      className="border border-slate-200 rounded-xl overflow-hidden bg-white flex flex-col"
                    >
                      <div className="aspect-video bg-slate-100 overflow-hidden">
                        <img
                          src={t.url}
                          alt={`${thumbResult.title} - ${t.label}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="p-3.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[18px] font-medium text-black truncate">{t.label}</p>
                          <p className="text-[18px] tabular-nums text-black">
                            {t.width}×{t.height}
                            {t.sizeBytes ? ` · ${formatBytes(t.sizeBytes)}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void enqueueProxyDownload(
                              `${thumbResult.title} (${t.label})`,
                              'youtube',
                              'JPG',
                              `${t.width}×${t.height}`,
                              t.url,
                              t.filename,
                              t.sizeBytes
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          <ArrowDownToLine className="w-4 h-4" />
                          JPG
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tool 3: Direct Video-to-MP3 Converter */}
        {activeTab === 'mp3' && (
          <div className="space-y-5 pt-2 border-t border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setMp3Mode('file')}
                  className={`px-3.5 py-2 text-[18px] font-medium rounded-md transition-colors whitespace-nowrap text-black ${
                    mp3Mode === 'file' ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
                  }`}
                >
                  Subir archivo de video
                </button>
                <button
                  type="button"
                  onClick={() => setMp3Mode('url')}
                  className={`px-3.5 py-2 text-[18px] font-medium rounded-md transition-colors whitespace-nowrap text-black ${
                    mp3Mode === 'url' ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
                  }`}
                >
                  Convertir desde URL
                </button>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="mp3-bitrate" className="text-[18px] font-medium text-black">
                  Calidad MP3:
                </label>
                <select
                  id="mp3-bitrate"
                  value={mp3Bitrate}
                  onChange={(e) => setMp3Bitrate(e.target.value as '128k' | '192k' | '320k')}
                  className="h-11 px-3 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                >
                  <option value="128k">128 kbps</option>
                  <option value="192k">192 kbps</option>
                  <option value="320k">320 kbps</option>
                </select>
              </div>
            </div>

            <form onSubmit={handleConvertMp3Submit} className="space-y-4">
              {mp3Mode === 'file' ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = e.dataTransfer.files?.[0];
                    if (dropped) setSelectedFile(dropped);
                  }}
                  className="border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-50/60"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.m4a,.wav,.ogg"
                    className="hidden"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  />
                  <div className="space-y-2">
                    <Upload className="w-7 h-7 text-black mx-auto" />
                    {selectedFile ? (
                      <div className="space-y-1">
                        <p className="text-[18px] font-semibold text-black">{selectedFile.name}</p>
                        <p className="text-[18px] tabular-nums text-black">
                          {formatBytes(selectedFile.size)} · Listo para extraer audio a MP3 ({mp3Bitrate})
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-[18px] font-medium text-black">
                          Haz clic o arrastra un video aquí (MP4, MOV, WebM, MKV)
                        </p>
                        <p className="text-[18px] text-black">
                          Conversión directa en servidor con FFmpeg hasta 150 MB
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <input
                  type="url"
                  required
                  placeholder="Pega la URL del video (TikTok, Facebook, YouTube o MP4 directo)…"
                  value={mp3Url}
                  onChange={(e) => setMp3Url(e.target.value)}
                  className="w-full h-12 px-4 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                />
              )}

              {mp3Error && (
                <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-[18px] text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-1" />
                  <span>{mp3Error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={convertingMp3}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 min-h-[48px] text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
              >
                {convertingMp3 ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <FileAudio className="w-5 h-5" />
                )}
                {convertingMp3 ? 'Convirtiendo audio a MP3…' : 'Convertir y descargar MP3'}
              </button>
            </form>
          </div>
        )}
      </section>

      {/* Clean Unified Download Manager */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-black">Gestor de descargas</h2>
              <span className="text-[18px] tabular-nums text-black">
                {queue.length} elementos
              </span>
            </div>
            <p className="text-[18px] text-black">
              Administra el progreso, cancela tareas o vuelve a guardar archivos descargados.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { key: 'all', label: 'Todas' },
                  { key: 'active', label: 'En curso' },
                  { key: 'completed', label: 'Completadas' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setQueueFilter(tab.key)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap text-black ${
                    queueFilter === tab.key ? 'bg-white shadow-xs font-semibold' : 'hover:bg-slate-200/60'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {queue.some((i) => i.status === 'completed' || i.status === 'cancelled') && (
              <button
                type="button"
                onClick={() =>
                  setQueue((prev) =>
                    prev.filter((i) => i.status === 'downloading' || i.status === 'converting')
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-black bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4" />
                Limpiar lista
              </button>
            )}
          </div>
        </div>

        {filteredQueue.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <ArrowDownToLine className="w-7 h-7 text-black mx-auto" />
            <p className="text-[18px] font-semibold text-black">Cola de descargas vacía</p>
            <p className="text-[18px] text-black">
              Todas tus descargas de videos, imágenes, miniaturas y conversiones a MP3 aparecerán aquí.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredQueue.map((item) => (
              <div
                key={item.id}
                className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-[18px]">
                    <span className="font-semibold text-black truncate max-w-md">
                      {item.title}
                    </span>
                    <span className="text-black" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-black">
                      {platformDisplayName(item.platform)}
                    </span>
                    <span className="text-black" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-black">
                      {item.format} ({item.quality})
                    </span>
                  </div>

                  {(item.status === 'downloading' || item.status === 'converting') && (
                    <div className="space-y-1 max-w-md">
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-600 transition-all duration-150"
                          style={{ width: `${item.progressPct}%` }}
                        />
                      </div>
                      <p className="text-[18px] tabular-nums text-black">
                        {item.status === 'converting'
                          ? 'Convirtiendo audio con FFmpeg…'
                          : `Descargando ${formatBytes(item.bytesLoaded)}${
                              item.bytesTotal ? ` de ${formatBytes(item.bytesTotal)}` : ''
                            } (${item.progressPct}%)`}
                      </p>
                    </div>
                  )}

                  {item.status === 'completed' && (
                    <p className="text-[18px] text-emerald-700 inline-flex items-center gap-1.5 tabular-nums">
                      <CheckCircle2 className="w-5 h-5 shrink-0" />
                      Completado · {formatBytes(item.bytesLoaded)}
                    </p>
                  )}

                  {item.status === 'error' && (
                    <p className="text-[18px] text-red-600">{item.errorMessage || 'Error en descarga'}</p>
                  )}

                  {item.status === 'cancelled' && (
                    <p className="text-[18px] text-black">Cancelado por el usuario</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {(item.status === 'downloading' || item.status === 'converting') && (
                    <button
                      type="button"
                      onClick={() => item.abortController?.abort()}
                      className="inline-flex items-center gap-1 px-3.5 py-2 text-[18px] font-medium text-black bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <X className="w-4 h-4" />
                      Cancelar
                    </button>
                  )}

                  {item.status === 'completed' && item.blobUrl && (
                    <button
                      type="button"
                      onClick={() => triggerBrowserSave(item.blobUrl!, item.filename)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <ArrowDownToLine className="w-4 h-4" />
                      Guardar archivo
                    </button>
                  )}

                  {item.status === 'error' && item.sourceUrl && item.platform !== 'mp3-converter' && (
                    <button
                      type="button"
                      onClick={() =>
                        void enqueueProxyDownload(
                          item.title,
                          item.platform as MediaPlatform,
                          item.format,
                          item.quality,
                          item.sourceUrl!,
                          item.filename,
                          item.bytesTotal
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium text-black bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Reintentar
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
                      setQueue((prev) => prev.filter((q) => q.id !== item.id));
                    }}
                    title="Quitar de la lista"
                    className="inline-flex items-center justify-center p-2.5 text-black hover:text-red-600 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
