import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import { syncPush } from './lib/push';
import { Icon, Sheet, useToast } from './components/ui';
import { ChatSheet } from './components/ChatSheet';
import { EventEditor, ScopeHost, type EditorTarget } from './components/EventEditor';
import { PendingSheet } from './components/PendingSheet';
import { Today } from './pages/Today';
import { Agenda } from './pages/Agenda';
import { Goals, GoalDetail } from './pages/Goals';
import { Budget } from './pages/Budget';
import { Settings } from './pages/Settings';
import { Snooze } from './pages/Snooze';
import { Auth } from './pages/Auth';

export type Me = {
  user: { id: string; email: string; name: string; timezone: string };
  settings: any;
  push: { enabled: boolean; error: string | null; publicKey: string | null; subscriptions: number };
  vision: { provider: string; configured: boolean; redactCardNumbers: boolean };
  hasSamples: boolean;
  today: string;
};

type Ctx = {
  me: Me;
  openChat: () => void;
  openEditor: (t: EditorTarget) => void;
  openPending: (importId?: string) => void;
  refreshAll: () => void;
};
const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

const NAV: [string, string, keyof typeof Icon][] = [
  ['/', "Aujourd'hui", 'today'],
  ['/agenda', 'Agenda', 'calendar'],
  ['/objectifs', 'Objectifs', 'target'],
  ['/budget', 'Budget', 'wallet'],
];

function QuickAdd({ onClose }: { onClose: () => void }) {
  const { openChat, openEditor } = useApp();
  return (
    <Sheet title="Ajouter" onClose={onClose}>
      <div className="stack">
        <button className="btn block" onClick={() => (onClose(), openEditor({ mode: 'new', kind: 'flexible' }))}>
          <Icon.check /> Une tâche
        </button>
        <button className="btn block" onClick={() => (onClose(), openEditor({ mode: 'new', kind: 'fixed' }))}>
          <Icon.calendar /> Un événement
        </button>
        <button className="btn block primary" onClick={() => (onClose(), openChat())}>
          <Icon.wallet /> Une dépense
        </button>
      </div>
    </Sheet>
  );
}

/** Interroge l'historique des notifications pour afficher les rappels quand l'app est ouverte. */
function useInAppNotifications(enabled: boolean) {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    let last = new Date().toISOString();
    const t = setInterval(async () => {
      try {
        const list = await api.get<any[]>('/api/notifications');
        for (const n of list.filter((x) => x.sent_at > last).reverse()) toast(`${n.title} — ${n.body}`);
        if (list[0]) last = list[0].sent_at > last ? list[0].sent_at : last;
      } catch {}
    }, 30000);
    return () => clearInterval(t);
  }, [enabled, toast]);
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const [chat, setChat] = useState(false);
  const [quick, setQuick] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [pending, setPending] = useState<{ importId?: string } | null>(null);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  useInAppNotifications(true);
  useEffect(() => {
    syncPush(me.push.publicKey).then((r) => {
      if (r !== 'none') qc.invalidateQueries({ queryKey: ['me'] });
    });
  }, [me.push.publicKey, qc]);

  useEffect(() => {
    if (params.get('chat') === '1') {
      setChat(true);
      params.delete('chat');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const refreshAll = useCallback(() => qc.invalidateQueries(), [qc]);
  const ctx: Ctx = {
    me,
    openChat: () => setChat(true),
    openEditor: (t) => setEditor(t),
    openPending: (importId) => setPending({ importId }),
    refreshAll,
  };
  const narrow = !loc.pathname.startsWith('/agenda');
  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <nav className="side-nav" aria-label="Navigation principale">
          <div className="brand">PLWR</div>
          {NAV.map(([to, label, ic]) => {
            const I = Icon[ic];
            return (
              <NavLink key={to} to={to} end={to === '/'}>
                <I /> {label}
              </NavLink>
            );
          })}
          <div className="spacer" />
          <NavLink to="/reglages">
            <Icon.settings /> Réglages
          </NavLink>
        </nav>
        <main className={`main${narrow ? ' narrow' : ''}`}>{children}</main>
        <nav className="bottom-nav" aria-label="Navigation principale">
          {NAV.map(([to, label, ic]) => {
            const I = Icon[ic];
            return (
              <NavLink key={to} to={to} end={to === '/'}>
                <I />
                {label}
              </NavLink>
            );
          })}
        </nav>
        <button className="fab" aria-label="Ajouter" onClick={() => setQuick(true)}>
          <Icon.plus />
        </button>
      </div>
      {quick && <QuickAdd onClose={() => setQuick(false)} />}
      {chat && <ChatSheet onClose={() => (setChat(false), refreshAll())} />}
      {editor && <EventEditor target={editor} onClose={() => (setEditor(null), refreshAll())} />}
      <ScopeHost />
      {pending && <PendingSheet importId={pending.importId} onClose={() => (setPending(null), refreshAll())} />}
    </AppCtx.Provider>
  );
}

export function App() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me'), retry: false });
  useEffect(() => {
    const h = () => qc.setQueryData(['me'], null);
    window.addEventListener('plwr:unauthorized', h);
    return () => window.removeEventListener('plwr:unauthorized', h);
  }, [qc]);
  const loc = useLocation();
  if (loc.pathname === '/rappel') return <Snooze />;
  if (me.isLoading) return <div className="empty">Chargement…</div>;
  if (!me.data) return <Auth onDone={() => (qc.invalidateQueries({ queryKey: ['me'] }), nav('/'))} />;
  return (
    <Shell me={me.data}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/agenda" element={<Agenda />} />
        <Route path="/objectifs" element={<Goals />} />
        <Route path="/objectifs/:id" element={<GoalDetail />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/reglages" element={<Settings />} />
        <Route path="*" element={<Today />} />
      </Routes>
    </Shell>
  );
}
