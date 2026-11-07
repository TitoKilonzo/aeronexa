import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export function InstallAppButton({ compact = false }: { compact?: boolean }) {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [fallbackMessage, setFallbackMessage] = useState('');

  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(isStandalone);
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setPromptEvent(null); };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) {
      const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent);
      setFallbackMessage(isAppleMobile
        ? 'Tap Share, then Add to Home Screen.'
        : 'Open your browser menu and choose Install AeroNexa.');
      return;
    }
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      setPromptEvent(null);
      if (choice.outcome === 'accepted') setInstalled(true);
    } catch (error) {
      console.error('AeroNexa installation prompt failed:', error);
    }
  };

  if (installed) return null;

  return <>
    <button type="button" onClick={() => void install()} className={`inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white font-extrabold text-navy transition hover:border-aviation hover:bg-sky ${compact ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm'}`}>
      <Download size={compact ? 14 : 16}/><span>Install AeroNexa</span>
    </button>
    {fallbackMessage && <div className="fixed bottom-5 right-5 z-[80] max-w-sm rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-navy shadow-xl" role="status">
      {fallbackMessage}
      <button type="button" className="ml-3 text-slate-400" aria-label="Dismiss" onClick={() => setFallbackMessage('')}>×</button>
    </div>}
  </>;
}

export function ConnectionStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);
  if (online) return null;
  return <div className="sticky top-0 z-[60] flex items-center justify-center gap-2 bg-amber-100 px-4 py-2 text-center text-xs font-bold text-amber-900">You are offline. Saved app pages remain available; live flights, bookings and payments need a connection.</div>;
}
