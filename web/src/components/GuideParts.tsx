import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dayLabel, dt, time } from '../lib/format';
import { Icon, useToast } from './ui';

/** Briques communes aux guides de synchronisation (Google Agenda, Outlook). */

export type Provider = 'google' | 'outlook';

export type SyncStatus = {
  redirectUri: string;
  hasCredentials: boolean;
  credentialsSource: 'user' | 'server' | null;
  clientId: string | null;
  connected: boolean;
  email: string | null;
  export: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastResult: { pushed: number; deleted: number; added: number; updated: number; removed: number } | null;
  imported: number;
  exported: number;
  syncMinutes: number;
  tenant?: string | null;
};


export const useSyncStatus = (p: Provider) => useQuery({ queryKey: [p], queryFn: () => api.get<SyncStatus>(`/api/${p}/status`) });

export async function copy(text: string, toast: (s: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié');
  } catch {
    window.prompt('Copie ce texte :', text);
  }
}

// ---------- Illustrations schématiques (repères visuels, pas des captures) ----------

export function Shot({ url, children, caption }: { url: string; children: ReactNode; caption?: string }) {
  return (
    <figure className="shot">
      <div className="shot-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <em>{url}</em>
      </div>
      <div className="shot-body">{children}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
export const Field = ({ label, value, hl }: { label: string; value?: string; hl?: boolean }) => (
  <div className={`shot-field${hl ? ' hl' : ''}`}>
    <small>{label}</small>
    <span>{value || ' '}</span>
  </div>
);
export const Btn = ({ children, hl, ghost }: { children: ReactNode; hl?: boolean; ghost?: boolean }) => <span className={`shot-btn${hl ? ' hl' : ''}${ghost ? ' ghost' : ''}`}>{children}</span>;
export const Line = ({ w = 60 }: { w?: number }) => <span className="shot-line" style={{ width: `${w}%` }} />;
export function Step({ n, title, done, current, children }: { n: number; title: string; done?: boolean; current?: boolean; children: ReactNode }) {
  return (
    <section className={`step${done ? ' done' : ''}${current ? ' current' : ''}`} id={`etape-${n}`} aria-label={`Étape ${n} : ${title}`}>
      <div className="step-head">
        <span className="step-num" aria-hidden="true">
          {done ? <Icon.check /> : n}
        </span>
        <h2>
          <span className="tiny muted block">Étape {n}</span>
          {title}
        </h2>
      </div>
      <div className="step-body">{children}</div>
    </section>
  );
}


const NAMES: Record<Provider, { label: string; who: string }> = {
  google: { label: 'Google Agenda', who: 'Google' },
  outlook: { label: 'Outlook', who: 'Outlook' },
};

/**
 * Page de synchronisation : en-tête, statut (connexion, synchro, envoi vers l'agenda externe, déconnexion),
 * puis le guide propre au fournisseur.
 */
export function SyncPage({ provider, connectStep, children }: { provider: Provider; connectStep: number; children: (st: SyncStatus, refresh: () => void) => ReactNode }) {
  const { label, who } = NAMES[provider];
  const q = useSyncStatus(provider);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(params.get('erreur'));
  const refresh = () => (qc.invalidateQueries({ queryKey: [provider] }), qc.invalidateQueries({ queryKey: ['events'] }));

  useEffect(() => {
    if (params.get('ok')) {
      toast(`${label} connecté · première synchronisation en cours`);
      setTimeout(refresh, 2500);
    }
    if (params.get('ok') || params.get('erreur')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = q.data;
  if (!st) return <div className="empty">Chargement…</div>;

  async function syncNow() {
    setSyncing(true);
    try {
      const x = (await api.post(`/api/${provider}/sync`)).result;
      toast(`Synchronisé · ${x.added} ajouté(s), ${x.updated} modifié(s), ${x.removed} retiré(s) depuis ${who}${st!.export ? ` · ${x.pushed} envoyé(s)` : ''}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSyncing(false);
      refresh();
    }
  }
  async function disconnect() {
    if (!confirm(`Déconnecter ${label} ? Les événements importés de ${who} disparaissent de PLWR (ils restent dans ${who}).`)) return;
    await api.post(`/api/${provider}/disconnect`);
    toast(`${label} déconnecté`);
    refresh();
  }
  async function toggleExport() {
    await api.patch(`/api/${provider}/settings`, { export: !st!.export });
    refresh();
  }

  return (
    <>
      <div className="agenda-head">
        <button className="round-btn" onClick={() => nav('/reglages')} aria-label="Retour aux réglages">
          <Icon.chevronL />
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="eyebrow">Synchroniser mon agenda</div>
          <h1>{label}</h1>
        </div>
      </div>

      {error && (
        <div className="banner danger small" role="alert" style={{ marginBottom: 12 }}>
          <span className="grow">{error}</span>
          <button className="icon-btn" aria-label="Fermer le message" onClick={() => setError(null)}>
            <Icon.close />
          </button>
        </div>
      )}

      <section className="card stack" data-testid={`${provider}-status`}>
        <div className="row" style={{ gap: 12 }}>
          <span className={`status-dot${st.connected ? (st.lastError ? ' warn' : ' on') : ''}`} aria-hidden="true" />
          <div className="grow" style={{ minWidth: 0 }}>
            <strong className="block">{st.connected ? 'Connecté' : st.hasCredentials ? 'Prêt à connecter' : 'Pas encore connecté'}</strong>
            <span className="small muted block">
              {st.connected
                ? `${st.email || `Compte ${who}`} · ${st.lastSyncAt ? `synchro ${dayLabel(dt(st.lastSyncAt).toISODate()!).toLowerCase()} à ${time(st.lastSyncAt)}` : 'première synchro en cours'}`
                : st.hasCredentials
                  ? `Il reste à autoriser PLWR (étape ${st.credentialsSource === 'server' ? 1 : connectStep}).`
                  : 'Suis les étapes ci-dessous : environ 10 minutes, une seule fois.'}
            </span>
          </div>
        </div>
        {st.connected && st.lastError && <div className="banner danger small">{st.lastError}</div>}
        {st.connected && (
          <>
            <div className="stats">
              <div className="stat">
                <span className="v">{st.imported}</span>
                <span className="tiny muted">venus de {who}</span>
              </div>
              <div className="stat">
                <span className="v">{st.exported}</span>
                <span className="tiny muted">envoyés à {who}</span>
              </div>
              <div className="stat">
                <span className="v">{st.syncMinutes} min</span>
                <span className="tiny muted">entre deux synchros</span>
              </div>
            </div>
            <ul className="group">
              <li>
                <span className="grow">
                  Envoyer mes événements PLWR vers {who}
                  <span className="block tiny muted">Ceux créés ici apparaissent aussi dans {label}.</span>
                </span>
                <button type="button" role="switch" aria-checked={st.export} aria-label={`Envoyer mes événements PLWR vers ${who}`} className={`switch${st.export ? ' on' : ''}`} onClick={toggleExport}>
                  <span />
                </button>
              </li>
            </ul>
            <div className="row wrap">
              <button className="btn primary grow" onClick={syncNow} disabled={syncing}>
                <Icon.repeat /> {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
              </button>
              <button className="btn danger" onClick={disconnect}>
                Déconnecter
              </button>
            </div>
          </>
        )}
        {!st.connected && st.hasCredentials && (
          <button className="btn primary block" onClick={() => connectTo(provider)}>
            Connecter {label}
          </button>
        )}
      </section>

      <h2 style={{ margin: '28px 4px 4px' }}>Comment faire, de A à Z</h2>
      {children(st, refresh)}
    </>
  );
}

export const connectTo = (provider: Provider) => (window.location.href = `/api/${provider}/connect`);
