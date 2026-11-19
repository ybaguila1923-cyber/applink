import { useEffect, useState } from 'react';
import { doc, getDoc, increment, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ArrowLeft, ExternalLink, Loader2, MessageSquare, ShieldAlert } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { detectClientTelemetry, generateShortCode, isValidShortCode } from '../lib/whatsapp';
import type { PublicRedirect } from '../types/app';

interface RedirectViewProps {
  shortCode: string;
  onGoHome: () => void;
}

export function RedirectView({ shortCode, onGoHome }: RedirectViewProps) {
  const [status, setStatus] = useState<'loading' | 'redirecting' | 'paused' | 'not_found' | 'error'>('loading');
  const [targetUrl, setTargetUrl] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function processRedirect() {
      if (!isValidShortCode(shortCode)) {
        setStatus('not_found');
        return;
      }

      const redirectPath = `publicRedirects/${shortCode}`;
      try {
        const redirectRef = doc(db, 'publicRedirects', shortCode);
        const snap = await getDoc(redirectRef);

        if (cancelled) return;
        if (!snap.exists()) {
          setStatus('not_found');
          return;
        }

        const data = snap.data() as PublicRedirect;
        setTargetUrl(data.targetUrl);

        if (!data.active) {
          setStatus('paused');
          return;
        }

        const telemetry = detectClientTelemetry();
        const clickId = `clk_${generateShortCode(12)}`;
        const clickRef = doc(db, 'publicRedirects', shortCode, 'clicks', clickId);

        const batch = writeBatch(db);
        batch.set(clickRef, {
          clickId,
          shortCode,
          ownerId: data.ownerId,
          deviceType: telemetry.deviceType,
          browser: telemetry.browser,
          os: telemetry.os,
          referrer: telemetry.referrer,
          clickedAt: serverTimestamp(),
        });
        batch.update(redirectRef, {
          clickCount: increment(1),
          updatedAt: serverTimestamp(),
        });

        await batch.commit();
        if (cancelled) return;

        setStatus('redirecting');
        window.setTimeout(() => {
          window.location.replace(data.targetUrl);
        }, 350);
      } catch (err) {
        if (cancelled) return;
        try {
          handleFirestoreError(err, OperationType.WRITE, redirectPath);
        } catch (wrapped) {
          setErrorMsg(wrapped instanceof Error ? wrapped.message : 'No se pudo procesar el enlace.');
          setStatus('error');
        }
      }
    }

    void processRedirect();
    return () => {
      cancelled = true;
    };
  }, [shortCode]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-5">
        {status === 'loading' && (
          <>
            <Loader2 className="w-8 h-8 text-emerald-600 animate-spin mx-auto" />
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold text-slate-900">Conectando con WhatsApp</h1>
              <p className="text-sm text-slate-500">Registrando enlace /{shortCode} y redirigiendo…</p>
            </div>
          </>
        )}

        {status === 'redirecting' && (
          <>
            <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold text-slate-900">Abriendo conversación en WhatsApp</h1>
              <p className="text-sm text-slate-500">
                Si la aplicación no se abre automáticamente, usa el botón de abajo.
              </p>
            </div>
            <div className="pt-2 flex flex-col gap-2.5">
              <a
                href={targetUrl}
                className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Abrir WhatsApp ahora
              </a>
              <button
                type="button"
                onClick={onGoHome}
                className="inline-flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Volver a EnlaceFlow
              </button>
            </div>
          </>
        )}

        {status === 'paused' && (
          <>
            <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold text-slate-900">Enlace pausado</h1>
              <p className="text-sm text-slate-500">
                El creador de este enlace acortado lo ha desactivado temporalmente.
              </p>
            </div>
            <button
              type="button"
              onClick={onGoHome}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Ir a EnlaceFlow
            </button>
          </>
        )}

        {(status === 'not_found' || status === 'error') && (
          <>
            <div className="w-12 h-12 rounded-xl bg-red-50 text-red-600 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold text-slate-900">
                {status === 'not_found' ? 'Enlace no encontrado' : 'Error al abrir enlace'}
              </h1>
              <p className="text-sm text-slate-500 break-words">
                {status === 'not_found'
                  ? `No existe ningún enlace activo con el código "${shortCode}".`
                  : errorMsg}
              </p>
            </div>
            <button
              type="button"
              onClick={onGoHome}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Crear un enlace de WhatsApp
            </button>
          </>
        )}
      </div>
    </div>
  );
}
