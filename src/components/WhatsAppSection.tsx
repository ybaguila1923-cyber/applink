import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
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
  Download,
  ExternalLink,
  Link2,
  Loader2,
  LogIn,
  MessageSquare,
  Pause,
  Play,
  QrCode,
  Search,
  Scissors,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  buildWhatsAppUrl,
  COUNTRY_CODES,
  generateShortCode,
  isValidShortCode,
  parseWhatsAppFormatting,
  sanitizeDigits,
} from '../lib/whatsapp';
import type { PublicRedirect, UserLink } from '../types/app';
import { ClickAnalyticsPanel } from './ClickAnalyticsPanel';

interface WhatsAppSectionProps {
  user: User | null;
  authLoading: boolean;
  onSignIn: () => Promise<void>;
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
  user,
  authLoading,
  onSignIn,
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

  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const qrWrapperRef = useRef<HTMLDivElement | null>(null);
  const analyticsSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusAnalytics && analyticsSectionRef.current) {
      analyticsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusAnalytics]);

  useEffect(() => {
    if (!user) {
      setLinks([]);
      setRedirectsByCode({});
      return;
    }

    setLoadingLinks(true);
    const linksPath = `users/${user.uid}/links`;
    const linksQuery = query(
      collection(db, 'users', user.uid, 'links'),
      where('ownerId', '==', user.uid)
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

    const redirectsQuery = query(
      collection(db, 'publicRedirects'),
      where('ownerId', '==', user.uid)
    );

    const unsubRedirects = onSnapshot(
      redirectsQuery,
      (snap) => {
        const map: Record<string, PublicRedirect> = {};
        snap.forEach((docSnap) => {
          const data = docSnap.data() as PublicRedirect;
          map[data.shortCode] = data;
        });
        setRedirectsByCode(map);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'publicRedirects');
      }
    );

    return () => {
      unsubLinks();
      unsubRedirects();
    };
  }, [user]);

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

    if (!user) {
      await onSignIn();
      return;
    }

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

      const userLinkRef = doc(db, 'users', user.uid, 'links', linkId);
      batch.set(userLinkRef, {
        id: linkId,
        ownerId: user.uid,
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
          ownerId: user.uid,
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
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/links`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (link: UserLink) => {
    if (!user) return;
    const nextActive = !link.active;
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', user.uid, 'links', link.id), {
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
      handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/links/${link.id}`);
    }
  };

  const handleDeleteLink = async (link: UserLink) => {
    if (!user) return;
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', user.uid, 'links', link.id));
    if (link.isShortened && link.shortCode) {
      batch.delete(doc(db, 'publicRedirects', link.shortCode));
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/links/${link.id}`);
    }
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
    <div className="space-y-8">
      {/* Builder & Live Preview */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Form */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
              Generador de URL de WhatsApp
            </h1>
            <p className="text-sm text-slate-600">
              Crea enlaces directos con mensaje predefinido, acórtalos con seguimiento de clics y guarda tu historial.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-5 space-y-1.5">
              <label htmlFor="wa-country" className="block text-xs font-medium text-slate-700">
                Código de país
              </label>
              <select
                id="wa-country"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="w-full h-11 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={`${c.iso}-${c.code}`} value={c.code}>
                    +{c.code} · {c.country}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-7 space-y-1.5">
              <label htmlFor="wa-phone" className="block text-xs font-medium text-slate-700">
                Número de WhatsApp
              </label>
              <input
                id="wa-phone"
                type="tel"
                inputMode="numeric"
                placeholder="Ej. 5512345678"
                value={phone}
                onChange={(e) => setPhone(sanitizeDigits(e.target.value).slice(0, 18))}
                className="w-full h-11 px-3.5 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="wa-message" className="text-xs font-medium text-slate-700">
                Mensaje predefinido personalizado
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('*')}
                  title="Negrita"
                  className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                >
                  Negrita
                </button>
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('_')}
                  title="Cursiva"
                  className="px-2.5 py-1 text-xs italic text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                >
                  Cursiva
                </button>
                <button
                  type="button"
                  onClick={() => applyFormatWrapper('~')}
                  title="Tachado"
                  className="px-2.5 py-1 text-xs line-through text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
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
              className="w-full p-3.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 resize-y"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {MESSAGE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    onClick={() => setMessage(tpl.text)}
                    className="px-2.5 py-1 text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {message.length}/2000
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-sm font-medium text-slate-900">
                  Acortar enlace y rastrear clics
                </span>
                <p className="text-xs text-slate-500">
                  Genera una URL corta con conteo en tiempo real por dispositivo y navegador.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={shortenEnabled}
                onClick={() => setShortenEnabled((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${
                  shortenEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                    shortenEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="wa-label" className="block text-xs font-medium text-slate-700">
                  Etiqueta para tu historial (opcional)
                </label>
                <input
                  id="wa-label"
                  type="text"
                  maxLength={100}
                  placeholder="Ej. Campaña Facebook Ads"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
                />
              </div>

              {shortenEnabled && (
                <div className="space-y-1.5">
                  <label htmlFor="wa-slug" className="block text-xs font-medium text-slate-700">
                    Alias personalizado (opcional)
                  </label>
                  <div className="flex items-center h-10 bg-slate-50 border border-slate-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-emerald-600/20 focus-within:border-emerald-600">
                    <span className="pl-3 pr-1 text-xs font-mono text-slate-400 select-none">/s/</span>
                    <input
                      id="wa-slug"
                      type="text"
                      maxLength={32}
                      placeholder="auto-generado"
                      value={customSlug}
                      onChange={(e) =>
                        setCustomSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))
                      }
                      className="w-full h-full pr-3 text-sm font-mono bg-transparent text-slate-900 placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {formError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {formError}
            </div>
          )}

          {saveFeedback && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center justify-between gap-2">
              <span className="truncate">{saveFeedback}</span>
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {user ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveLink}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : shortenEnabled ? (
                  <Scissors className="w-4 h-4" />
                ) : (
                  <Link2 className="w-4 h-4" />
                )}
                {shortenEnabled ? 'Generar y acortar enlace' : 'Guardar en historial'}
              </button>
            ) : (
              <button
                type="button"
                disabled={authLoading}
                onClick={onSignIn}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
              >
                <LogIn className="w-4 h-4" />
                Iniciar sesión para acortar y guardar
              </button>
            )}

            <button
              type="button"
              disabled={!generatedWaUrl}
              onClick={() => handleCopy('preview-wa', generatedWaUrl)}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {copiedKey === 'preview-wa' ? (
                <Check className="w-4 h-4 text-emerald-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              {copiedKey === 'preview-wa' ? 'URL copiada' : 'Copiar URL directa'}
            </button>
          </div>
        </div>

        {/* Right: Live WhatsApp Preview & QR */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Vista previa en tiempo real</h2>
            <span className="text-xs font-mono text-slate-500">
              +{cleanCode} {cleanPhone || '••••••••••'}
            </span>
          </div>

          {/* Chat Simulation Surface */}
          <div className="rounded-xl overflow-hidden border border-slate-200">
            <div className="bg-emerald-800 text-white px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-emerald-700 flex items-center justify-center text-xs font-semibold">
                WA
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {label.trim() || `+${cleanCode} ${cleanPhone || 'Tu número'}`}
                </p>
                <p className="text-[11px] text-emerald-200">Enlace directo de chat</p>
              </div>
            </div>
            <div className="bg-slate-100 p-4 min-h-[120px] flex flex-col justify-end">
              <div className="ml-auto max-w-[88%] bg-emerald-100 text-slate-900 rounded-xl rounded-tr-sm px-3.5 py-2.5 text-sm leading-relaxed break-words shadow-xs">
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
                  <span className="text-slate-400 italic">Sin mensaje predefinido</span>
                )}
                <div className="text-[10px] text-emerald-800/70 text-right mt-1 font-mono tabular-nums">
                  Ahora
                </div>
              </div>
            </div>
          </div>

          {/* Generated URL & QR */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-600">URL generada</p>
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg font-mono text-xs text-slate-700 break-all">
                {generatedWaUrl || 'Ingresa un número para ver tu enlace https://wa.me/...'}
              </div>
              {shortenEnabled && (
                <p className="text-xs text-slate-500 font-mono truncate">
                  Enlace corto al guardar: {window.location.origin}/s/{previewSlug}
                </p>
              )}
            </div>

            {generatedWaUrl && (
              <div className="flex flex-col sm:flex-row items-center gap-4 pt-2">
                <div
                  ref={qrWrapperRef}
                  className="p-2.5 bg-white border border-slate-200 rounded-lg shrink-0"
                >
                  <QRCodeCanvas value={generatedWaUrl} size={108} level="M" />
                </div>
                <div className="flex-1 w-full space-y-2">
                  <p className="text-xs text-slate-600">
                    Escanea el código QR desde cualquier móvil o descárgalo para flyers y tarjetas.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadQr}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      Descargar QR
                    </button>
                    <a
                      href={generatedWaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Probar WhatsApp
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* User Link History */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-900">Historial de enlaces creados</h2>
              {user && (
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {links.length} enlaces · {totalClicksAll} clics totales
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Cada usuario mantiene su historial privado sincronizado en la nube.
            </p>
          </div>

          {user && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  placeholder="Buscar por nombre o número…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full sm:w-56 h-9 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
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
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      filterMode === tab.key
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {!user ? (
          <div className="p-8 text-center space-y-3">
            <MessageSquare className="w-7 h-7 text-slate-400 mx-auto" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-900">
                Inicia sesión para guardar y consultar tu historial
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Accede con tu cuenta de Google para acortar enlaces de WhatsApp, consultar estadísticas de clics en
                tiempo real y administrar tus enlaces desde cualquier dispositivo.
              </p>
            </div>
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              Continuar con Google
            </button>
          </div>
        ) : loadingLinks ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-11 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filteredLinks.length === 0 ? (
          <div className="p-8 text-center space-y-1.5">
            <p className="text-sm font-medium text-slate-900">
              {links.length === 0
                ? 'Todavía no has guardado ningún enlace'
                : 'No hay enlaces que coincidan con tu búsqueda'}
            </p>
            <p className="text-xs text-slate-500">
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
                  className="px-5 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 truncate">
                        {link.label}
                      </span>
                      <span className="text-xs text-slate-400" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-xs font-mono tabular-nums text-slate-600">
                        +{link.countryCode} {link.phone}
                      </span>
                      {link.isShortened && (
                        <>
                          <span className="text-xs text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span
                            className={`text-xs font-medium ${
                              link.active ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {link.active ? 'Activo' : 'Pausado'}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="text-xs font-mono text-emerald-700 truncate">{bestUrl}</p>
                    {link.message && (
                      <p className="text-xs text-slate-500 truncate max-w-2xl">{link.message}</p>
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
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded-lg transition-colors tabular-nums whitespace-nowrap"
                      >
                        <BarChart3 className="w-3.5 h-3.5" />
                        {clickCount} clics
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleCopy(link.id, bestUrl)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap"
                    >
                      {copiedKey === link.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {copiedKey === link.id ? 'Copiado' : 'Copiar'}
                    </button>

                    <a
                      href={link.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir en WhatsApp"
                      className="inline-flex items-center justify-center p-2 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>

                    {link.isShortened && (
                      <button
                        type="button"
                        onClick={() => handleToggleActive(link)}
                        title={link.active ? 'Pausar enlace' : 'Reactivar enlace'}
                        className="inline-flex items-center justify-center p-2 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        {link.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleDeleteLink(link)}
                      title="Eliminar enlace"
                      className="inline-flex items-center justify-center p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Click Analytics Panel */}
      {user && (
        <section ref={analyticsSectionRef}>
          <ClickAnalyticsPanel
            userId={user.uid}
            links={links}
            redirectsByCode={redirectsByCode}
            selectedLinkId={selectedAnalyticsLinkId}
            onSelectLink={(id) => setSelectedAnalyticsLinkId(id)}
          />
        </section>
      )}
    </div>
  );
}
