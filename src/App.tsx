import { useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MediaStudioSection } from './components/MediaStudioSection';
import { RedirectView } from './components/RedirectView';
import { WhatsAppSection } from './components/WhatsAppSection';
import { getOrCreateWorkspaceId } from './lib/whatsapp';

type WorkspaceSection = 'whatsapp' | 'analytics' | 'media';

function parseShortCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([a-zA-Z0-9_-]{1,64})\/?$/);
  return match ? match[1] : null;
}

function AppContent() {
  const [shortCodeRoute, setShortCodeRoute] = useState<string | null>(() =>
    parseShortCodeFromPath(window.location.pathname)
  );
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('whatsapp');
  const [workspaceId, setWorkspaceId] = useState<string>(() => getOrCreateWorkspaceId());

  useEffect(() => {
    const onPopState = () => {
      setShortCodeRoute(parseShortCodeFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleGoHome = () => {
    window.history.pushState({}, '', '/');
    setShortCodeRoute(null);
  };

  if (shortCodeRoute) {
    return <RedirectView shortCode={shortCodeRoute} onGoHome={handleGoHome} />;
  }

  const navItems: { key: WorkspaceSection; label: string }[] = [
    { key: 'whatsapp', label: 'WhatsApp y Enlaces' },
    { key: 'analytics', label: 'Estadísticas' },
    { key: 'media', label: 'Descargas y MP3' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-black text-[18px] flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('whatsapp');
            }}
            className="font-display text-xl font-bold tracking-tight text-black whitespace-nowrap shrink-0"
          >
            EnlaceFlow
          </a>

          <nav
            aria-label="Navegación principal"
            className="hidden md:flex items-center gap-6 text-[18px] font-medium"
          >
            {navItems.map((item) => {
              const active = activeSection === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveSection(item.key)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 text-black ${
                    active
                      ? 'font-semibold border-emerald-600'
                      : 'border-transparent hover:border-slate-300'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() =>
                setActiveSection((prev) => (prev === 'media' ? 'whatsapp' : 'media'))
              }
              className="inline-flex items-center justify-center px-4 py-2 text-[18px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {activeSection === 'media' ? 'Ir a WhatsApp' : 'Ir a Descargas'}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile inline section switcher (non-sticky so sticky cap stays <= 64px) */}
      <div className="md:hidden bg-white border-b border-slate-200 px-4 py-2">
        <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
          {navItems.map((item) => {
            const active = activeSection === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveSection(item.key)}
                className={`min-h-[44px] px-2 text-sm font-medium rounded-md transition-colors truncate text-black ${
                  active ? 'bg-white shadow-xs font-semibold' : ''
                }`}
              >
                {item.key === 'whatsapp'
                  ? 'WhatsApp'
                  : item.key === 'analytics'
                  ? 'Estadísticas'
                  : 'Descargas'}
              </button>
            );
          })}
        </div>
      </div>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {activeSection === 'media' ? (
          <MediaStudioSection />
        ) : (
          <WhatsAppSection
            workspaceId={workspaceId}
            onChangeWorkspaceId={setWorkspaceId}
            focusAnalytics={activeSection === 'analytics'}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-5 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[18px] text-black">
          <span>EnlaceFlow · Generador de WhatsApp, Acortador y Estudio Multimedia</span>
          <span>Acceso libre · Compatible con móviles y escritorio</span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
