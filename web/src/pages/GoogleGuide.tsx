import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dayLabel, dt, time } from '../lib/format';
import { Icon, useToast } from '../components/ui';

type Status = {
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
};

export const useGoogleStatus = () => useQuery({ queryKey: ['google'], queryFn: () => api.get<Status>('/api/google/status') });

async function copy(text: string, toast: (s: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié');
  } catch {
    window.prompt('Copie ce texte :', text);
  }
}

// ---------- Illustrations schématiques (repères visuels, pas des captures) ----------

function Shot({ url, children, caption }: { url: string; children: ReactNode; caption?: string }) {
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
const Field = ({ label, value, hl }: { label: string; value?: string; hl?: boolean }) => (
  <div className={`shot-field${hl ? ' hl' : ''}`}>
    <small>{label}</small>
    <span>{value || ' '}</span>
  </div>
);
const Btn = ({ children, hl, ghost }: { children: ReactNode; hl?: boolean; ghost?: boolean }) => <span className={`shot-btn${hl ? ' hl' : ''}${ghost ? ' ghost' : ''}`}>{children}</span>;
const Line = ({ w = 60 }: { w?: number }) => <span className="shot-line" style={{ width: `${w}%` }} />;
function Step({ n, title, done, current, children }: { n: number; title: string; done?: boolean; current?: boolean; children: ReactNode }) {
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

// ---------- Import des variables (fichier JSON ou saisie) ----------

function CredentialsForm({ st, onSaved }: { st: Status; onSaved: () => void }) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [warn, setWarn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(!st.hasCredentials || st.credentialsSource === 'server');
  const fileRef = useRef<HTMLInputElement>(null);

  async function save(id = clientId, sec = secret) {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/google/credentials', { clientId: id, clientSecret: sec });
      toast('Identifiants Google importés');
      setEdit(false);
      setClientId('');
      setSecret('');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Lit le fichier « client_secret_….json » téléchargé depuis Google Cloud (rien n'est envoyé avant « Importer »). */
  async function readFile(f: File) {
    setError(null);
    setWarn(null);
    try {
      const data = JSON.parse(await f.text());
      const c = data.web || data.installed;
      if (!c?.client_id || !c?.client_secret) throw new Error('Ce fichier ne contient pas d’ID client et de code secret.');
      if (data.installed) setWarn('Ce fichier vient d’un client « Application de bureau ». Crée plutôt un client « Application Web » (étape 4).');
      else if (Array.isArray(c.redirect_uris) && !c.redirect_uris.includes(st.redirectUri)) {
        setWarn('L’URI de redirection de l’étape 4 n’est pas dans ce client : ajoute-la dans Google Cloud, sinon la connexion échouera.');
      }
      setClientId(c.client_id);
      setSecret(c.client_secret);
    } catch (e) {
      setError(e instanceof SyntaxError ? 'Fichier illisible : choisis le fichier .json téléchargé à l’étape 4.' : (e as Error).message);
    }
  }

  if (!edit)
    return (
      <div className="banner info small" data-testid="credentials-ok">
        <Icon.check style={{ width: 18, height: 18, flex: 'none' }} />
        <span className="grow" style={{ minWidth: 0 }}>
          Identifiants importés
          <span className="block tiny muted ellipsis">{st.clientId}</span>
        </span>
        <button className="btn small" onClick={() => setEdit(true)}>
          Remplacer
        </button>
      </div>
    );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <button type="button" className="dropzone" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]))}>
        <Icon.upload />
        <strong>Choisir le fichier JSON</strong>
        <span className="tiny muted">client_secret_….json, téléchargé à l’étape 4</span>
      </button>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Fichier JSON des identifiants Google" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
      <div className="divider-text">ou colle-les</div>
      <label className="field">
        ID client
        <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456-abc….apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
      </label>
      <label className="field">
        Code secret du client
        <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" autoComplete="off" spellCheck={false} />
      </label>
      {warn && <div className="banner small">{warn}</div>}
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || !clientId || !secret} onClick={() => save()}>
        Importer mes identifiants
      </button>
      <div className="tiny muted">Le code secret est chiffré sur le serveur et n’est jamais réaffiché.</div>
    </div>
  );
}

// ---------- Page ----------

export function GoogleGuide() {
  const q = useGoogleStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(params.get('erreur'));
  const refresh = () => (qc.invalidateQueries({ queryKey: ['google'] }), qc.invalidateQueries({ queryKey: ['events'] }));

  useEffect(() => {
    if (params.get('ok')) {
      toast('Google Agenda connecté · première synchronisation en cours');
      setTimeout(refresh, 2500);
    }
    if (params.get('ok') || params.get('erreur')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = q.data;
  if (!st) return <div className="empty">Chargement…</div>;
  const server = st.credentialsSource === 'server';
  const current = st.connected ? 7 : st.hasCredentials ? 6 : 1;

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await api.post('/api/google/sync');
      const x = r.result;
      toast(`Synchronisé · ${x.added} ajouté(s), ${x.updated} modifié(s), ${x.removed} retiré(s) depuis Google${st!.export ? ` · ${x.pushed} envoyé(s)` : ''}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSyncing(false);
      refresh();
    }
  }
  async function disconnect() {
    if (!confirm('Déconnecter Google Agenda ? Les événements importés de Google disparaissent de PLWR (ils restent dans Google).')) return;
    await api.post('/api/google/disconnect');
    toast('Google Agenda déconnecté');
    refresh();
  }
  async function toggleExport() {
    await api.patch('/api/google/settings', { export: !st!.export });
    refresh();
  }
  const connect = () => (window.location.href = '/api/google/connect');

  return (
    <>
      <div className="agenda-head">
        <button className="round-btn" onClick={() => nav('/reglages')} aria-label="Retour aux réglages">
          <Icon.chevronL />
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="eyebrow">Synchroniser mon agenda</div>
          <h1>Google Agenda</h1>
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

      <section className="card stack" data-testid="google-status">
        <div className="row" style={{ gap: 12 }}>
          <span className={`status-dot${st.connected ? (st.lastError ? ' warn' : ' on') : ''}`} aria-hidden="true" />
          <div className="grow" style={{ minWidth: 0 }}>
            <strong className="block">{st.connected ? 'Connecté' : st.hasCredentials ? 'Prêt à connecter' : 'Pas encore connecté'}</strong>
            <span className="small muted block">
              {st.connected
                ? `${st.email || 'Compte Google'} · ${st.lastSyncAt ? `synchro ${dayLabel(dt(st.lastSyncAt).toISODate()!).toLowerCase()} à ${time(st.lastSyncAt)}` : 'première synchro en cours'}`
                : st.hasCredentials
                  ? 'Il reste à autoriser PLWR (étape 6).'
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
                <span className="tiny muted">venus de Google</span>
              </div>
              <div className="stat">
                <span className="v">{st.exported}</span>
                <span className="tiny muted">envoyés à Google</span>
              </div>
              <div className="stat">
                <span className="v">{st.syncMinutes} min</span>
                <span className="tiny muted">entre deux synchros</span>
              </div>
            </div>
            <ul className="group">
              <li>
                <span className="grow">
                  Envoyer mes événements PLWR vers Google
                  <span className="block tiny muted">Ceux créés ici apparaissent aussi dans Google Agenda.</span>
                </span>
                <button type="button" role="switch" aria-checked={st.export} aria-label="Envoyer mes événements PLWR vers Google" className={`switch${st.export ? ' on' : ''}`} onClick={toggleExport}>
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
          <button className="btn primary block" onClick={connect}>
            Connecter Google Agenda
          </button>
        )}
      </section>

      <h2 style={{ margin: '28px 4px 4px' }}>Comment faire, de A à Z</h2>
      <p className="muted small" style={{ margin: '0 4px 16px' }}>
        {server
          ? 'Les identifiants Google sont déjà configurés sur le serveur : il te reste seulement à autoriser PLWR (étape 6).'
          : 'Chaque personne relie son propre Google Agenda avec ses propres identifiants. Fais-le sur un ordinateur, c’est plus confortable ; la connexion marche ensuite partout, iPhone compris.'}
      </p>

      <div className="steps">
        {!server && (
          <>
            <Step n={1} title="Créer un projet Google Cloud" done={current > 1} current={current === 1}>
              <ol>
                <li>
                  Ouvre{' '}
                  <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
                    console.cloud.google.com
                  </a>{' '}
                  avec le compte Google de ton agenda.
                </li>
                <li>
                  En haut, clique sur le sélecteur de projet, puis <b>Nouveau projet</b>.
                </li>
                <li>
                  Nom du projet : <b>PLWR</b> → <b>Créer</b>. Vérifie ensuite qu’il est bien sélectionné en haut de la page.
                </li>
              </ol>
              <Shot url="console.cloud.google.com/projectcreate" caption="Un projet gratuit suffit, aucune carte de crédit n’est demandée pour l’API Agenda.">
                <strong className="shot-title">Nouveau projet</strong>
                <Field label="Nom du projet" value="PLWR" hl />
                <Field label="Emplacement" value="Aucune organisation" />
                <div className="shot-actions">
                  <Btn hl>Créer</Btn>
                  <Btn ghost>Annuler</Btn>
                </div>
              </Shot>
            </Step>

            <Step n={2} title="Activer l’API Google Calendar" done={current > 2} current={false}>
              <ol>
                <li>
                  Menu ☰ → <b>API et services</b> → <b>Bibliothèque</b>.
                </li>
                <li>
                  Cherche <b>Google Calendar API</b>, ouvre-la, puis clique sur <b>Activer</b>.
                </li>
              </ol>
              <Shot url="console.cloud.google.com/apis/library">
                <div className="shot-search">Google Calendar API</div>
                <div className="shot-card">
                  <span className="shot-icon" aria-hidden="true">
                    <Icon.calendar />
                  </span>
                  <div className="grow">
                    <strong>Google Calendar API</strong>
                    <Line w={80} />
                  </div>
                </div>
                <div className="shot-actions">
                  <Btn hl>Activer</Btn>
                </div>
              </Shot>
            </Step>

            <Step n={3} title="Remplir l’écran de consentement OAuth" done={current > 3} current={false}>
              <p className="small" style={{ marginTop: 0 }}>
                C’est la fiche que Google te montrera au moment d’autoriser PLWR (étape 6).
              </p>
              <ol>
                <li>
                  Menu ☰ → <b>API et services</b> → <b>Écran de consentement OAuth</b> (aussi appelé <b>Google Auth Platform</b>) → <b>Commencer</b>.
                </li>
                <li>
                  <b>Informations sur l’application</b> : nom <b>PLWR</b>, adresse e-mail d’assistance = ton courriel → <b>Suivant</b>.
                </li>
                <li>
                  <b>Audience</b> : choisis <b>Externe</b> → <b>Suivant</b>.
                </li>
                <li>
                  <b>Coordonnées</b> : ton courriel → <b>Suivant</b>, accepte le règlement → <b>Créer</b>.
                </li>
                <li>
                  Section <b>Accès aux données</b> (Data access) → <b>Ajouter ou supprimer des champs d’application</b> → coche{' '}
                  <code>…/auth/calendar.events</code> → <b>Mettre à jour</b> → <b>Enregistrer</b>.
                </li>
                <li>
                  Section <b>Audience</b> → <b>Publier l’application</b> → <b>Confirmer</b>.
                </li>
              </ol>
              <div className="banner small">
                <span>
                  <b>Important :</b> si l’application reste « En test », Google coupe l’accès après 7 jours et il faut reconnecter chaque semaine. Publie-la : comme c’est ton propre projet, aucune
                  validation de Google n’est nécessaire.
                </span>
              </div>
              <Shot url="console.cloud.google.com/auth/overview/create">
                <strong className="shot-title">Configuration du projet</strong>
                <Field label="Nom de l’application" value="PLWR" hl />
                <Field label="Adresse e-mail d’assistance utilisateur" value="ton.courriel@gmail.com" />
                <div className="shot-radio">
                  <span className="hl">◉ Externe</span>
                  <span>○ Interne</span>
                </div>
              </Shot>
              <Shot url="console.cloud.google.com/auth/scopes" caption="Le seul accès nécessaire : les événements de tes agendas.">
                <strong className="shot-title">Ajouter ou supprimer des champs d’application</strong>
                <div className="shot-check hl">
                  <span className="box">✓</span>
                  <span>
                    <code>…/auth/calendar.events</code>
                    <small className="block">Afficher et modifier les événements de tous vos agendas</small>
                  </span>
                </div>
                <div className="shot-check">
                  <span className="box" />
                  <Line w={70} />
                </div>
                <div className="shot-actions">
                  <Btn hl>Mettre à jour</Btn>
                </div>
              </Shot>
              <Shot url="console.cloud.google.com/auth/audience">
                <strong className="shot-title">Audience</strong>
                <Field label="État de publication" value="En test" />
                <div className="shot-actions">
                  <Btn hl>Publier l’application</Btn>
                </div>
              </Shot>
            </Step>

            <Step n={4} title="Créer l’identifiant OAuth (tes variables)" done={current > 4} current={false}>
              <ol>
                <li>
                  Section <b>Clients</b> → <b>Créer un client</b> (ou <b>Identifiants</b> → <b>Créer des identifiants</b> → <b>ID client OAuth</b>).
                </li>
                <li>
                  Type d’application : <b>Application Web</b>. Nom : <b>PLWR</b>.
                </li>
                <li>
                  Sous <b>URI de redirection autorisés</b> → <b>Ajouter un URI</b>, colle exactement :
                </li>
              </ol>
              <div className="copy-box">
                <code data-testid="redirect-uri">{st.redirectUri}</code>
                <button className="btn small" onClick={() => copy(st.redirectUri, toast)}>
                  <Icon.copy /> Copier
                </button>
              </div>
              <ol start={4}>
                <li>
                  <b>Créer</b>. Une fenêtre affiche ton <b>ID client</b> et ton <b>Code secret du client</b> : clique sur <b>Télécharger le fichier JSON</b>.
                </li>
              </ol>
              <Shot url="console.cloud.google.com/auth/clients/create">
                <strong className="shot-title">Créer un ID client OAuth</strong>
                <Field label="Type d’application" value="Application Web" hl />
                <Field label="Nom" value="PLWR" />
                <Field label="URI de redirection autorisés" value={st.redirectUri} hl />
                <div className="shot-actions">
                  <Btn hl>Créer</Btn>
                </div>
              </Shot>
              <Shot url="console.cloud.google.com/auth/clients" caption="Garde ce code secret pour toi : il sert seulement à l’étape 5.">
                <strong className="shot-title">Client OAuth créé</strong>
                <Field label="ID client" value="123456789-abc….apps.googleusercontent.com" />
                <Field label="Code secret du client" value="GOCSPX-••••••••••••" />
                <div className="shot-actions">
                  <Btn hl>
                    <Icon.upload style={{ width: 14, height: 14, transform: 'rotate(180deg)' }} /> Télécharger le fichier JSON
                  </Btn>
                </div>
              </Shot>
            </Step>

            <Step n={5} title="Importer tes variables dans PLWR" done={current > 5} current={false}>
              <p className="small" style={{ marginTop: 0 }}>
                Dépose le fichier téléchargé à l’étape 4, ou colle l’ID client et le code secret.
              </p>
              <CredentialsForm st={st} onSaved={refresh} />
            </Step>
          </>
        )}

        <Step n={server ? 1 : 6} title="Autoriser PLWR sur l’écran de Google" done={st.connected} current={current === 6}>
          <ol>
            <li>
              Touche <b>Connecter Google Agenda</b> ci-dessous et choisis ton compte Google.
            </li>
            {!server && (
              <li>
                Google affiche <b>« Google n’a pas validé cette application »</b> : c’est normal, c’est ton propre projet. Touche <b>Paramètres avancés</b> → <b>Accéder à PLWR (non sécurisé)</b>.
              </li>
            )}
            <li>
              Sur l’écran de consentement, <b>coche</b> l’accès à Google Agenda, puis <b>Continuer</b>. Tu reviens ici avec « Connecté ».
            </li>
          </ol>
          <div className="shots-row">
            {!server && (
              <Shot url="accounts.google.com">
                <strong className="shot-title">Google n’a pas validé cette application</strong>
                <Line w={90} />
                <Line w={70} />
                <span className="shot-link hl">Paramètres avancés</span>
                <span className="shot-link">Accéder à PLWR (non sécurisé)</span>
              </Shot>
            )}
            <Shot url="accounts.google.com" caption="La fiche de consentement de Google : vérifie que l’agenda est coché.">
              <strong className="shot-title">PLWR souhaite accéder à votre compte Google</strong>
              <div className="shot-check hl">
                <span className="box">✓</span>
                <span>Afficher et modifier les événements de tous vos agendas</span>
              </div>
              <div className="shot-actions">
                <Btn ghost>Annuler</Btn>
                <Btn hl>Continuer</Btn>
              </div>
            </Shot>
          </div>
          {st.connected ? (
            <div className="banner info small">
              <Icon.check style={{ width: 18, height: 18, flex: 'none' }} /> Connecté à {st.email || 'Google'}.
            </div>
          ) : (
            <button className="btn primary block" onClick={connect} disabled={!st.hasCredentials}>
              Connecter Google Agenda
            </button>
          )}
          {!st.hasCredentials && <div className="tiny muted">Importe d’abord tes identifiants (étape 5).</div>}
        </Step>

        <Step n={server ? 2 : 7} title="C’est synchronisé" done={st.connected && !st.lastError} current={current === 7}>
          <ul className="bullets">
            <li>
              Tes événements Google arrivent dans PLWR toutes les {st.syncMinutes} minutes (et quand tu touches <b>Synchroniser maintenant</b>). Ils sont en lecture seule ici : modifie-les dans Google
              Agenda.
            </li>
            <li>Ce que tu crées dans PLWR part vers Google quelques secondes après (option ci-dessus).</li>
            <li>
              Les personnes qui partagent ton agenda voient aussi tes événements Google, selon l’accès que tu leur as donné. Un événement <b>privé</b> dans Google arrive en « Occupé seulement ».
            </li>
            <li>Les événements « toute la journée » ne sont pas importés.</li>
            <li>Pour que tout le monde soit synchronisé, chaque personne suit ce guide avec son propre compte Google.</li>
          </ul>
        </Step>
      </div>
    </>
  );
}
