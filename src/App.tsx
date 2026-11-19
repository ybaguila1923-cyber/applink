import { useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { LogIn, LogOut } from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MediaStudioSection } from './components/MediaStudioSection';
import { RedirectView } from './components/RedirectView';
import { WhatsAppSection } from './components/WhatsAppSection';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './lib/firebase';

type WorkspaceSection = 'whatsapp' | 'analytics' | 'media';

function parseShortCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([a-zA-Z0-9_-]{1,64})\/?$/);
  return match ? match[1] : null;
}

async function syncUserProfile(user: User) {
  const userPath = `users/${user.uid}`;
  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    const payload = {
      email: (user.email || '').slice(0, 254),
      displayName: (user.displayName || '').slice(0, 120),
      photoURL: (user.photoURL || '').slice(0, 512),
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        ...payload,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, payload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

function AppContent() {
  const [shortCodeRoute, setShortCodeRoute] = useState<string | null>(() =>
    parseShortCodeFromPath(window.location.pathname)
  );
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('whatsapp');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    const onPopState = () => {
      setShortCodeRoute(parseShortCodeFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAvatarError(false);
      setAuthLoading(false);
      if (nextUser) {
        void syncUserProfile(nextUser);
      }
    });
    return () => unsub();
  }, []);

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo iniciar sesión.';
      if (!msg.includes('popup-closed-by-user')) {
        setAuthError(msg);
      }
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

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

  const userInitial = (user?.displayName || user?.email || 'U').charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('whatsapp');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            EnlaceFlow
          </a>

          <nav
            aria-label="Navegación principal"
            className="hidden md:flex items-center gap-6 text-sm font-medium"
          >
            {navItems.map((item) => {
              const active = activeSection === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveSection(item.key)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    active
                      ? 'text-slate-900 border-emerald-600'
                      : 'text-slate-600 hover:text-slate-900 border-transparent'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center shrink-0">
            {user ? (
              <button
                type="button"
                onClick={handleSignOut}
                title="Cerrar sesión"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {user.photoURL && !avatarError ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'Usuario'}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarError(true)}
                    className="w-5 h-5 rounded-full object-cover"
                  />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-emerald-700 text-white text-[11px] font-semibold flex items-center justify-center">
                    {userInitial}
                  </span>
                )}
                <span className="hidden sm:inline max-w-[110px] truncate">
                  {user.displayName?.split(' ')[0] || 'Mi cuenta'}
                </span>
                <LogOut className="w-3.5 h-3.5 text-slate-500" />
              </button>
            ) : (
              <button
                type="button"
                disabled={authLoading}
                onClick={handleSignIn}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                Iniciar sesión
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile inline section switcher (non-sticky so sticky cap stays <= 56px) */}
      <div className="md:hidden bg-white border-b border-slate-200 px-4 py-2">
        <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
          {navItems.map((item) => {
            const active = activeSection === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveSection(item.key)}
                className={`min-h-[40px] px-2 text-xs font-medium rounded-md transition-colors truncate ${
                  active
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
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

      {authError && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4">
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between gap-2">
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="font-medium underline"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {activeSection === 'media' ? (
          <MediaStudioSection />
        ) : (
          <WhatsAppSection
            user={user}
            authLoading={authLoading}
            onSignIn={handleSignIn}
            focusAnalytics={activeSection === 'analytics'}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-5 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>EnlaceFlow · Generador de WhatsApp, Acortador y Estudio Multimedia</span>
          <span>Compatible con dispositivos móviles y escritorio</span>
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
