import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { QRCodeCanvas } from 'qrcode.react';
import {
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Pause,
  Play,
  QrCode,
  Scissors,
  Search,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  buildWhatsAppUrl,
  COUNTRY_CODES,
  generateShortCode,
  isValidShortCode,
  isValidWorkspaceId,
  parseWhatsAppFormatting,
  sanitizeDigits,
  saveWorkspaceId,
} from '../lib/whatsapp';
import type { PublicRedirect, UserLink } from '../types/app';
import { ClickAnalyticsPanel } from './ClickAnalyticsPanel';

interface WhatsAppSectionProps {
  workspaceId: string;
  onChangeWorkspaceId: (nextId: string) => void;
  focusAnalytics?: boolean;
}

const MESSAGE_TEMPLATES = [
  {
    name: 'Ventas / Catálogo',
    text: 'Hola, me gustaría recibir *información y precios* sobre sus productos disponibles.',
  },
  {
    name: 'Soporte al cliente',
    text: 'Hola, necesito _asistencia técnica_ con mi pedido. Mi número de referencia es:',
  },
  {
    name: 'Agendar cita',
    text: 'Hola, quiero *reservar una cita*. ¿Qué horarios tienen disponibles esta semana?',
  },
];

export function WhatsAppSection({
  workspaceId,
  onChangeWorkspaceId,
  focusAnalytics = false,
}: WhatsAppSectionProps) {
  const [countryCode, setCountryCode] = useState('52');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState(
    'Hola, quiero más información sobre sus servicios.'
  );
  const [label, setLabel] = useState('');
  const [shortenEnabled, setShortenEnabled] = useState(true);
  const [customSlug, setCustomSlug] = useState('');

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [links, setLinks] = useState<UserLink[]>([]);
  const [redirectsByCode, setRedirectsByCode] = useState<Record<string, PublicRedirect>>({});
  const [loadingLinks, setLoadingLinks] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'shortened' | 'direct'>('all');
  const [selectedAnalyticsLinkId, setSelectedAnalyticsLinkId] = useState<string | null>(null);

  const [showWorkspaceTools, setShowWorkspaceTools] = useState(false);
  const [importWorkspaceInput, setImportWorkspaceInput] = useState('');
  const [workspaceMsg, setWorkspaceMsg] = useState<string | null>(null);

  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const qrWrapperRef = useRef<HTMLDivElement | null>(null);
  const analyticsSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusAnalytics && analyticsSectionRef.current) {
      analyticsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusAnalytics]);

  useEffect(() => {
    if (!workspaceId) return;

    setLoadingLinks(true);
    const linksPath = `workspaces/${workspaceId}/links`;
    const linksQuery = query(
      collection(db, 'workspaces', workspaceId, 'links'),
      where('workspaceId', '==', workspaceId)
    );

    const unsubLinks = onSnapshot(
      linksQuery,
      (snap) => {
        const items: UserLink[] = [];
        snap.forEach((docSnap) => {
          items.push(docSnap.data() as UserLink);
        });
        items.sort((a, b) => {
          const ta = a.createdAt?.toMillis?.() ?? 0;
          const tb = b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
        setLinks(items);
        setLoadingLinks(false);
      },
      (error) => {
        setLoadingLinks(false);
        handleFirestoreError(error, OperationType.LIST, linksPath);
      }
    );

    return () => unsubLinks();
  }, [workspaceId]);

  const shortenedCodesKey = useMemo(() => {
    return links
      .filter((l) => l.isShortened && l.shortCode)
      .map((l) => l.shortCode)
      .join(',');
  }, [links]);

  useEffect(() => {
    if (!shortenedCodesKey) {
      setRedirectsByCode({});
      return;
    }

    const codes = shortenedCodesKey.split(',').filter(Boolean);
    const unsubs = codes.map((code) =>
      onSnapshot(
        doc(db, 'publicRedirects', code),
        (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data() as PublicRedirect;
            setRedirectsByCode((prev) => ({ ...prev, [code]: data }));
          }
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, `publicRedirects/${code}`);
        }
      )
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [shortenedCodesKey]);

  const cleanPhone = sanitizeDigits(phone);
  const cleanCode = sanitizeDigits(countryCode) || '52';
  const generatedWaUrl = useMemo(
    () => buildWhatsAppUrl(cleanCode, cleanPhone, message),
    [cleanCode, cleanPhone, message]
  );

  const previewSlug = useMemo(() => {
    const trimmed = customSlug.trim();
    if (trimmed) return trimmed;
    return 'codigo';
  }, [customSlug]);

  const formattedSegments = useMemo(() => parseWhatsAppFormatting(message), [message]);

  const applyFormatWrapper = (wrapper: '*' | '_' | '~') => {
    const el = messageRef.current;
    if (!el) {
      setMessage((prev) => `${prev}${wrapper}texto${wrapper}`);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = message.slice(start, end) || 'texto';
    const next = `${message.slice(0, start)}${wrapper}${selected}${wrapper}${message.slice(end)}`;
    setMessage(next.slice(0, 2000));
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + 1, start + 1 + selected.length);
    });
  };

  const handleCopy = async (key: string, value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleDownloadQr = () => {
    const canvas = qrWrapperRef.current?.querySelector('canvas');
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `whatsapp_qr_${cleanCode}${cleanPhone || 'enlace'}.png`;
    a.click();
  };

  const handleSaveLink = async () => {
    setFormError(null);
    setSaveFeedback(null);

    if (cleanPhone.length < 4 || cleanPhone.length > 18) {
      setFormError('Ingresa un número de WhatsApp válido (entre 4 y 18 dígitos).');
      return;
    }

    if (!generatedWaUrl) {
      setFormError('No se pudo construir la URL de WhatsApp.');
      return;
    }

    let finalShortCode = '';
    let finalShortUrl = '';

    if (shortenEnabled) {
      const candidate = customSlug.trim() || generateShortCode(6);
      if (!isValidShortCode(candidate)) {
        setFormError(
          'El alias corto debe tener entre 3 y 32 caracteres (solo letras, números, guiones y guion bajo).'
        );
        return;
      }
      finalShortCode = candidate;
      finalShortUrl = `${window.location.origin}/s/${finalShortCode}`;
    }

    setSaving(true);
    try {
      if (shortenEnabled && finalShortCode) {
        const existingRedirect = await getDoc(doc(db, 'publicRedirects', finalShortCode));
        if (existingRedirect.exists()) {
          setFormError(
            `El alias "${finalShortCode}" ya está en uso. Elige otro o déjalo vacío para generar uno automático.`
          );
          setSaving(false);
          return;
        }
      }

      const linkId = `lnk_${generateShortCode(10)}`;
      const safeLabel = (label.trim() || `WhatsApp +${cleanCode} ${cleanPhone}`).slice(0, 100);
      const batch = writeBatch(db);

      const userLinkRef = doc(db, 'workspaces', workspaceId, 'links', linkId);
      batch.set(userLinkRef, {
        id: linkId,
        workspaceId,
        label: safeLabel,
        countryCode: cleanCode,
        phone: cleanPhone,
        message: message.slice(0, 2000),
        targetUrl: generatedWaUrl,
        shortCode: finalShortCode,
        shortUrl: finalShortUrl,
        isShortened: shortenEnabled,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (shortenEnabled && finalShortCode) {
        const redirectRef = doc(db, 'publicRedirects', finalShortCode);
        batch.set(redirectRef, {
          shortCode: finalShortCode,
          workspaceId,
          targetUrl: generatedWaUrl,
          active: true,
          clickCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      if (shortenEnabled) {
        setSelectedAnalyticsLinkId(linkId);
      }
      setLabel('');
      setCustomSlug('');
      setSaveFeedback(
        shortenEnabled
          ? `Enlace acortado guardado: ${finalShortUrl}`
          : 'Enlace guardado en tu historial.'
      );
      window.setTimeout(() => setSaveFeedback(null), 5000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `workspaces/${workspaceId}/links`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (link: UserLink) => {
    const nextActive = !link.active;
    const batch = writeBatch(db);
    batch.update(doc(db, 'workspaces', workspaceId, 'links', link.id), {
      active: nextActive,
      updatedAt: serverTimestamp(),
    });
    if (link.isShortened && link.shortCode) {
      batch.update(doc(db, 'publicRedirects', link.shortCode), {
        active: nextActive,
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `workspaces/${workspaceId}/links/${link.id}`);
    }
  };

  const handleDeleteLink = async (link: UserLink) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'workspaces', workspaceId, 'links', link.id));
    if (link.isShortened && link.shortCode) {
      batch.delete(doc(db, 'publicRedirects', link.shortCode));
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `workspaces/${workspaceId}/links/${link.id}`);
    }
  };

  const handleSwitchWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    setWorkspaceMsg(null);
    const trimmed = importWorkspaceInput.trim();
    if (!isValidWorkspaceId(trimmed)) {
      setWorkspaceMsg('La clave debe tener entre 16 y 64 caracteres (letras, números o guiones).');
      return;
    }
    saveWorkspaceId(trimmed);
    onChangeWorkspaceId(trimmed);
    setImportWorkspaceInput('');
    setWorkspaceMsg('Historial sincronizado con la nueva clave.');
  };

  const filteredLinks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return links.filter((l) => {
      if (filterMode === 'shortened' && !l.isShortened) return false;
      if (filterMode === 'direct' && l.isShortened) return false;
      if (!q) return true;
      return (
        l.label.toLowerCase().includes(q) ||
        l.phone.includes(q) ||
        l.message.toLowerCase().includes(q) ||
        l.shortCode.toLowerCase().includes(q)
      );
    });
  }, [links, searchTerm, filterMode]);

  const totalClicksAll = useMemo(() => {
    return links.reduce((sum, l) => {
      if (!l.isShortened || !l.shortCode) return sum;
      return sum + (redirectsByCode[l.shortCode]?.clickCount ?? 0);
    }, 0);
  }, [links, redirectsByCode]);

  return (
    <div className="space-y-8 text-black">
      {/* Builder & Live Preview */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Form */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-semibold text-black tracking-tight">
              Generador de URL de WhatsApp
            </h1>
            <p className="text-[18px] text-black leading-relaxed">
              Crea enlaces directos con mensaje predefinido, acórtalos con seguimiento de clics y guarda tu historial sin iniciar sesión.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-5 space-y-1.5">
              <label htmlFor="wa-country" className="block text-[18px] font-medium text-black">
                Código de país
              </label>
              <select
                id="wa-country"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="w-full h-12 px-3 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={`${c.iso}-${c.code}`} value={c.code}>
                    +{c.code} · {c.country}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-7 space-y-1.5">
              <label htmlFor="wa-phone" className="block text-[18px] font-medium text-black">
                Número de WhatsApp
              </label>
              <input
                id="wa-phone"
                type="tel"
                inputMode="numeric"
                placeholder="Ej. 5512345678"
                value={phone}
                onChange={(e) => setPhone(sanitizeDigits(e.target.value).slice(0, 18))}
                className="w-full h-12 px-3.5 text-[18px] tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="wa-message" className="text-[18px] font-medium text-black">
                Mensaje predefinido personalizado
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('*')}
                  title="Negrita"
                  className="px-3 py-1.5 text-sm font-semibold text-black bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                >
                  Negrita
                </button>
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('_')}
                  title="Cursiva"
                  className="px-3 py-1.5 text-sm italic text-black bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                >
                  Cursiva
                </button>
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('~')}
                  title="Tachado"
                  className="px-3 py-1.5 text-sm line-through text-black bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                >
                  Tachado
                </button>
              </div>
            </div>
            <textarea
              id="wa-message"
              ref={messageRef}
              rows={4}
              maxLength={2000}
              placeholder="Escribe el mensaje que aparecerá listo para enviar…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full p-3.5 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 resize-y leading-relaxed"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {MESSAGE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    onClick={() => setMessage(tpl.text)}
                    className="px-3 py-1.5 text-sm text-black bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
              <span className="text-sm tabular-nums text-black">
                {message.length}/2000
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-[18px] font-medium text-black block">
                  Acortar enlace y rastrear clics
                </span>
                <p className="text-[18px] text-black leading-relaxed">
                  Genera una URL corta con conteo en tiempo real por dispositivo y navegador.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={shortenEnabled}
                onClick={() => setShortenEnabled((v) => !v)}
                className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${
                  shortenEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-sm transition-transform ${
                    shortenEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="wa-label" className="block text-[18px] font-medium text-black">
                  Etiqueta (opcional)
                </label>
                <input
                  id="wa-label"
                  type="text"
                  maxLength={100}
                  placeholder="Ej. Campaña Facebook"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full h-11 px-3 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                />
              </div>

              {shortenEnabled && (
                <div className="space-y-1.5">
                  <label htmlFor="wa-slug" className="block text-[18px] font-medium text-black">
                    Alias corto (opcional)
                  </label>
                  <div className="flex items-center h-11 bg-slate-50 border border-slate-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-emerald-600/20 focus-within:border-emerald-600">
                    <span className="pl-3 pr-1 text-[18px] text-black select-none">/s/</span>
                    <input
                      id="wa-slug"
                      type="text"
                      maxLength={32}
                      placeholder="auto"
                      value={customSlug}
                      onChange={(e) =>
                        setCustomSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))
                      }
                      className="w-full h-full pr-3 text-[18px] bg-transparent text-black placeholder:text-neutral-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {formError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-[18px] text-red-700">
              {formError}
            </div>
          )}

          {saveFeedback && (
            <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-[18px] text-black flex items-center justify-between gap-2">
              <span className="truncate">{saveFeedback}</span>
              <Check className="w-5 h-5 text-emerald-600 shrink-0" />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveLink}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 min-h-[48px] text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
            >
              {saving ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : shortenEnabled ? (
                <Scissors className="w-5 h-5" />
              ) : (
                <Link2 className="w-5 h-5" />
              )}
              {shortenEnabled ? 'Generar y acortar enlace' : 'Guardar en historial'}
            </button>

            <button
              type="button"
              disabled={!generatedWaUrl}
              onClick={() => handleCopy('preview-wa', generatedWaUrl)}
              className="inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] text-[18px] font-medium text-black bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {copiedKey === 'preview-wa' ? (
                <Check className="w-5 h-5 text-emerald-600" />
              ) : (
                <Copy className="w-5 h-5" />
              )}
              {copiedKey === 'preview-wa' ? 'URL copiada' : 'Copiar URL directa'}
            </button>
          </div>
        </div>

        {/* Right: Live WhatsApp Preview & QR */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-semibold text-black">Vista previa en tiempo real</h2>
            <span className="text-[18px] tabular-nums text-black">
              +{cleanCode} {cleanPhone || '••••••••••'}
            </span>
          </div>

          <div className="rounded-xl overflow-hidden border border-slate-200">
            <div className="bg-emerald-800 text-white px-4 py-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-emerald-700 flex items-center justify-center text-sm font-semibold shrink-0">
                WA
              </div>
              <div className="min-w-0">
                <p className="text-[18px] font-medium text-white truncate">
                  {label.trim() || `+${cleanCode} ${cleanPhone || 'Tu número'}`}
                </p>
                <p className="text-sm text-emerald-100">Enlace directo de chat</p>
              </div>
            </div>
            <div className="bg-slate-100 p-4 min-h-[130px] flex flex-col justify-end">
              <div className="ml-auto max-w-[90%] bg-emerald-100 text-black rounded-xl rounded-tr-sm px-4 py-3 text-[18px] leading-relaxed break-words shadow-xs">
                {message.trim() ? (
                  <p className="whitespace-pre-wrap">
                    {formattedSegments.map((seg, idx) => {
                      if (seg.bold) return <strong key={idx}>{seg.text}</strong>;
                      if (seg.italic) return <em key={idx}>{seg.text}</em>;
                      if (seg.strike) return <s key={idx}>{seg.text}</s>;
                      return <span key={idx}>{seg.text}</span>;
                    })}
                  </p>
                ) : (
                  <span className="text-black italic">Sin mensaje predefinido</span>
                )}
                <div className="text-xs text-black/70 text-right mt-1 tabular-nums">
                  Ahora
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="space-y-1.5">
              <p className="text-[18px] font-medium text-black">URL generada</p>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[18px] text-black break-all">
                {generatedWaUrl || 'Ingresa un número para ver tu enlace https://wa.me/...'}
              </div>
              {shortenEnabled && (
                <p className="text-[18px] text-black truncate">
                  Corto: {window.location.origin}/s/{previewSlug}
                </p>
              )}
            </div>

            {generatedWaUrl && (
              <div className="flex flex-col sm:flex-row items-center gap-4 pt-2">
                <div
                  ref={qrWrapperRef}
                  className="p-2.5 bg-white border border-slate-200 rounded-lg shrink-0"
                >
                  <QRCodeCanvas value={generatedWaUrl} size={112} level="M" />
                </div>
                <div className="flex-1 w-full space-y-2.5">
                  <p className="text-[18px] text-black leading-relaxed">
                    Escanea el código QR o descárgalo en imagen PNG.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadQr}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-slate-100 hover:bg-slate-200 text-black rounded-lg transition-colors whitespace-nowrap"
                    >
                      <QrCode className="w-4 h-4" />
                      Descargar QR
                    </button>
                    <a
                      href={generatedWaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-emerald-50 hover:bg-emerald-100 text-black rounded-lg transition-colors whitespace-nowrap"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Probar WhatsApp
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Link History */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold text-black">Historial de enlaces creados</h2>
                <span className="text-[18px] tabular-nums text-black">
                  {links.length} enlaces · {totalClicksAll} clics totales
                </span>
              </div>
              <p className="text-[18px] text-black">
                Tu historial se guarda automáticamente en este navegador y en la nube sin crear cuenta.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-black absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  placeholder="Buscar enlace…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full sm:w-56 h-11 pl-9 pr-3 text-[18px] bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
                {(
                  [
                    { key: 'all', label: 'Todos' },
                    { key: 'shortened', label: 'Acortados' },
                    { key: 'direct', label: 'Directos' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilterMode(tab.key)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                      filterMode === tab.key
                        ? 'bg-white text-black shadow-xs'
                        : 'text-black hover:bg-slate-200/60'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowWorkspaceTools((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-black rounded-lg transition-colors whitespace-nowrap"
              >
                <KeyRound className="w-4 h-4" />
                Clave de historial
              </button>
            </div>
          </div>

          {showWorkspaceTools && (
            <div className="pt-3 border-t border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[18px] text-black">
                <span>Tu clave actual:</span>
                <code className="px-2.5 py-1 bg-slate-100 rounded text-sm text-black">{workspaceId}</code>
                <button
                  type="button"
                  onClick={() => handleCopy('ws-key', workspaceId)}
                  className="px-3 py-1 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-black rounded transition-colors"
                >
                  {copiedKey === 'ws-key' ? 'Copiada' : 'Copiar clave'}
                </button>
              </div>
              <form onSubmit={handleSwitchWorkspace} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Pegar clave de otro dispositivo…"
                  value={importWorkspaceInput}
                  onChange={(e) => setImportWorkspaceInput(e.target.value)}
                  className="h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg text-black placeholder:text-neutral-500"
                />
                <button
                  type="submit"
                  className="px-3.5 h-10 text-sm font-medium bg-black text-white rounded-lg hover:bg-neutral-800 transition-colors whitespace-nowrap"
                >
                  Cargar historial
                </button>
              </form>
              {workspaceMsg && <p className="text-sm text-black">{workspaceMsg}</p>}
            </div>
          )}
        </div>

        {loadingLinks ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredLinks.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-[18px] font-semibold text-black">
              {links.length === 0
                ? 'Todavía no has guardado ningún enlace'
                : 'No hay enlaces que coincidan con tu búsqueda'}
            </p>
            <p className="text-[18px] text-black">
              Usa el generador de arriba para crear tu primer enlace de WhatsApp personalizado.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredLinks.map((link) => {
              const clickCount =
                link.isShortened && link.shortCode
                  ? redirectsByCode[link.shortCode]?.clickCount ?? 0
                  : null;
              const bestUrl = link.isShortened && link.shortUrl ? link.shortUrl : link.targetUrl;

              return (
                <div
                  key={link.id}
                  className="px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[18px]">
                      <span className="font-semibold text-black truncate">
                        {link.label}
                      </span>
                      <span className="text-black" aria-hidden="true">
                        ·
                      </span>
                      <span className="tabular-nums text-black">
                        +{link.countryCode} {link.phone}
                      </span>
                      {link.isShortened && (
                        <>
                          <span className="text-black" aria-hidden="true">
                            ·
                          </span>
                          <span
                            className={`font-medium ${
                              link.active ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {link.active ? 'Activo' : 'Pausado'}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="text-[18px] text-emerald-700 truncate">{bestUrl}</p>
                    {link.message && (
                      <p className="text-[18px] text-black truncate max-w-2xl">{link.message}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {clickCount !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAnalyticsLinkId(link.id);
                          analyticsSectionRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start',
                          });
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-emerald-50 hover:bg-emerald-100 text-black rounded-lg transition-colors tabular-nums whitespace-nowrap"
                      >
                        <BarChart3 className="w-4 h-4 text-emerald-700" />
                        {clickCount} clics
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleCopy(link.id, bestUrl)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[18px] font-medium bg-slate-100 hover:bg-slate-200 text-black rounded-lg transition-colors whitespace-nowrap"
                    >
                      {copiedKey === link.id ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                      {copiedKey === link.id ? 'Copiado' : 'Copiar'}
                    </button>

                    <a
                      href={link.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir en WhatsApp"
                      className="inline-flex items-center justify-center p-2.5 text-black bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>

                    {link.isShortened && (
                      <button
                        type="button"
                        onClick={() => handleToggleActive(link)}
                        title={link.active ? 'Pausar enlace' : 'Reactivar enlace'}
                        className="inline-flex items-center justify-center p-2.5 text-black bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        {link.active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleDeleteLink(link)}
                      title="Eliminar enlace"
                      className="inline-flex items-center justify-center p-2.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Click Analytics Panel */}
      <section ref={analyticsSectionRef}>
        <ClickAnalyticsPanel
          workspaceId={workspaceId}
          links={links}
          redirectsByCode={redirectsByCode}
          selectedLinkId={selectedAnalyticsLinkId}
          onSelectLink={(id) => setSelectedAnalyticsLinkId(id)}
        />
      </section>
    </div>
  );
}
