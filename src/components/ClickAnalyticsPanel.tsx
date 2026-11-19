import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { ArrowUpRight, BarChart3, Copy, Check, Monitor, Smartphone, Tablet } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import type { ClickEvent, PublicRedirect, UserLink } from '../types/app';

interface ClickAnalyticsPanelProps {
  userId: string;
  links: UserLink[];
  redirectsByCode: Record<string, PublicRedirect>;
  selectedLinkId: string | null;
  onSelectLink: (linkId: string) => void;
}

export function ClickAnalyticsPanel({
  userId,
  links,
  redirectsByCode,
  selectedLinkId,
  onSelectLink,
}: ClickAnalyticsPanelProps) {
  const shortenedLinks = useMemo(
    () => links.filter((l) => l.isShortened && l.shortCode),
    [links]
  );

  const activeLink = useMemo(() => {
    if (selectedLinkId) {
      const found = shortenedLinks.find((l) => l.id === selectedLinkId);
      if (found) return found;
    }
    return shortenedLinks[0] || null;
  }, [selectedLinkId, shortenedLinks]);

  const [clicks, setClicks] = useState<ClickEvent[]>([]);
  const [loadingClicks, setLoadingClicks] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (!activeLink?.shortCode) {
      setClicks([]);
      return;
    }
    setLoadingClicks(true);
    const clicksPath = `publicRedirects/${activeLink.shortCode}/clicks`;
    const q = query(
      collection(db, 'publicRedirects', activeLink.shortCode, 'clicks'),
      where('ownerId', '==', userId),
      limit(500)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const items: ClickEvent[] = [];
        snap.forEach((docSnap) => {
          items.push(docSnap.data() as ClickEvent);
        });
        items.sort((a, b) => {
          const ta = a.clickedAt?.toMillis?.() ?? 0;
          const tb = b.clickedAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
        setClicks(items);
        setLoadingClicks(false);
      },
      (error) => {
        setLoadingClicks(false);
        handleFirestoreError(error, OperationType.LIST, clicksPath);
      }
    );

    return () => unsub();
  }, [activeLink?.shortCode, userId]);

  const stats = useMemo(() => {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    let todayClicks = 0;

    const devices: Record<'mobile' | 'desktop' | 'tablet', number> = {
      mobile: 0,
      desktop: 0,
      tablet: 0,
    };
    const browsers: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    const referrers: Record<string, number> = {};

    const last7Days: { key: string; label: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' });
      last7Days.push({ key, label, count: 0 });
    }
    const dayLookup = new Map(last7Days.map((d) => [d.key, d]));

    for (const c of clicks) {
      devices[c.deviceType] = (devices[c.deviceType] || 0) + 1;
      browsers[c.browser] = (browsers[c.browser] || 0) + 1;
      osMap[c.os] = (osMap[c.os] || 0) + 1;
      referrers[c.referrer] = (referrers[c.referrer] || 0) + 1;

      const dt = c.clickedAt?.toDate?.();
      if (dt) {
        const key = dt.toISOString().slice(0, 10);
        if (key === todayKey) todayClicks++;
        const bucket = dayLookup.get(key);
        if (bucket) bucket.count++;
      }
    }

    const total = clicks.length;
    const redirectCount = activeLink?.shortCode
      ? redirectsByCode[activeLink.shortCode]?.clickCount ?? total
      : 0;
    const displayTotal = Math.max(redirectCount, total);
    const mobilePct = total > 0 ? Math.round((devices.mobile / total) * 100) : 0;
    const maxDaily = Math.max(1, ...last7Days.map((d) => d.count));

    const sortTop = (map: Record<string, number>) =>
      Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    return {
      displayTotal,
      todayClicks,
      mobilePct,
      devices,
      topBrowsers: sortTop(browsers),
      topOs: sortTop(osMap),
      topReferrers: sortTop(referrers),
      last7Days,
      maxDaily,
      lastClickDate: clicks[0]?.clickedAt?.toDate?.() || null,
    };
  }, [clicks, activeLink?.shortCode, redirectsByCode]);

  if (shortenedLinks.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
        <BarChart3 className="w-7 h-7 text-slate-400 mx-auto" />
        <h3 className="text-base font-semibold text-slate-900">Aún no hay enlaces acortados con estadísticas</h3>
        <p className="text-sm text-slate-500 max-w-md mx-auto">
          Activa la opción &ldquo;Acortar enlace y rastrear clics&rdquo; al crear tu URL de WhatsApp para visualizar
          estadísticas en tiempo real por dispositivo, navegador y día.
        </p>
      </div>
    );
  }

  const handleCopyShort = async () => {
    if (!activeLink?.shortUrl) return;
    await navigator.clipboard.writeText(activeLink.shortUrl);
    setCopiedUrl(true);
    window.setTimeout(() => setCopiedUrl(false), 1800);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold text-slate-900">Estadísticas de clics en tiempo real</h3>
          <p className="text-xs text-slate-500">
            Selecciona cualquiera de tus enlaces acortados para inspeccionar su tráfico
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Seleccionar enlace acortado"
            value={activeLink?.id || ''}
            onChange={(e) => onSelectLink(e.target.value)}
            className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 max-w-[260px]"
          >
            {shortenedLinks.map((link) => {
              const count = redirectsByCode[link.shortCode]?.clickCount ?? 0;
              return (
                <option key={link.id} value={link.id}>
                  {link.label} ({count} clics)
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {activeLink && (
        <div className="p-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>+{activeLink.countryCode} {activeLink.phone}</span>
                <span aria-hidden="true">·</span>
                <span>{activeLink.active ? 'Enlace activo' : 'Enlace pausado'}</span>
              </div>
              <p className="font-mono text-sm text-emerald-700 truncate">{activeLink.shortUrl}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopyShort}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap"
              >
                {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedUrl ? 'Copiado' : 'Copiar corto'}
              </button>
              <a
                href={`/s/${activeLink.shortCode}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors whitespace-nowrap"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                Probar
              </a>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="py-2">
              <p className="text-xs text-slate-500">Clics totales</p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-1">{stats.displayTotal}</p>
            </div>
            <div className="py-2 border-l border-slate-100 pl-4">
              <p className="text-xs text-slate-500">Clics hoy</p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-1">{stats.todayClicks}</p>
            </div>
            <div className="py-2 lg:border-l border-slate-100 lg:pl-4">
              <p className="text-xs text-slate-500">Tráfico móvil</p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-1">{stats.mobilePct}%</p>
            </div>
            <div className="py-2 border-l border-slate-100 pl-4">
              <p className="text-xs text-slate-500">Último clic</p>
              <p className="text-sm font-medium text-slate-900 tabular-nums mt-2">
                {stats.lastClickDate
                  ? stats.lastClickDate.toLocaleString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Sin registros'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2 border-t border-slate-100">
            <div className="lg:col-span-7 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-900">Actividad de los últimos 7 días</h4>
                {loadingClicks && <span className="text-xs text-slate-400">Actualizando…</span>}
              </div>
              <div className="grid grid-cols-7 gap-2 items-end h-36 pt-4">
                {stats.last7Days.map((day) => {
                  const pct = Math.max(4, Math.round((day.count / stats.maxDaily) * 100));
                  return (
                    <div key={day.key} className="flex flex-col items-center gap-1.5 h-full justify-end">
                      <span className="text-xs font-mono tabular-nums text-slate-600">{day.count}</span>
                      <div className="w-full max-w-[36px] bg-slate-100 rounded-md h-24 flex items-end overflow-hidden">
                        <div
                          className="w-full bg-emerald-600 rounded-md transition-all duration-200"
                          style={{ height: day.count === 0 ? '4px' : `${pct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-slate-500 capitalize truncate max-w-full">
                        {day.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="lg:col-span-5 space-y-4">
              <h4 className="text-sm font-semibold text-slate-900">Distribución por dispositivo y navegador</h4>
              <div className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between text-slate-700">
                  <span className="inline-flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-slate-400" />
                    Móvil
                  </span>
                  <span className="font-mono tabular-nums font-medium">{stats.devices.mobile}</span>
                </div>
                <div className="flex items-center justify-between text-slate-700">
                  <span className="inline-flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-slate-400" />
                    Escritorio
                  </span>
                  <span className="font-mono tabular-nums font-medium">{stats.devices.desktop}</span>
                </div>
                <div className="flex items-center justify-between text-slate-700">
                  <span className="inline-flex items-center gap-2">
                    <Tablet className="w-4 h-4 text-slate-400" />
                    Tablet
                  </span>
                  <span className="font-mono tabular-nums font-medium">{stats.devices.tablet}</span>
                </div>
              </div>

              {stats.topBrowsers.length > 0 && (
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <p className="text-xs font-medium text-slate-500">Navegadores principales</p>
                  {stats.topBrowsers.map(([browser, count]) => (
                    <div key={browser} className="flex items-center justify-between text-xs text-slate-700">
                      <span className="truncate pr-2">{browser}</span>
                      <span className="font-mono tabular-nums text-slate-900 font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {clicks.length > 0 && (
            <div className="pt-4 border-t border-slate-100 space-y-3">
              <h4 className="text-sm font-semibold text-slate-900">Últimos clics registrados</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4 font-medium">Fecha y hora</th>
                      <th className="py-2 pr-4 font-medium">Dispositivo</th>
                      <th className="py-2 pr-4 font-medium">Sistema</th>
                      <th className="py-2 pr-4 font-medium">Navegador</th>
                      <th className="py-2 font-medium text-right">Origen</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {clicks.slice(0, 8).map((c) => (
                      <tr key={c.clickId} className="text-slate-700">
                        <td className="py-2 pr-4 font-mono tabular-nums whitespace-nowrap">
                          {c.clickedAt?.toDate?.()
                            ? c.clickedAt.toDate().toLocaleString('es-ES', {
                                day: '2-digit',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : 'Ahora'}
                        </td>
                        <td className="py-2 pr-4 capitalize">
                          {c.deviceType === 'mobile'
                            ? 'Móvil'
                            : c.deviceType === 'tablet'
                            ? 'Tablet'
                            : 'Escritorio'}
                        </td>
                        <td className="py-2 pr-4">{c.os}</td>
                        <td className="py-2 pr-4">{c.browser}</td>
                        <td className="py-2 text-right text-slate-500">{c.referrer}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
