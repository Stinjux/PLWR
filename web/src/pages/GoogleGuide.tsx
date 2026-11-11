import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon, useToast } from '../components/ui';
import { Btn, Field, Line, Shot, Step, SyncPage, connectTo, copy, useSyncStatus, type SyncStatus } from '../components/GuideParts';

type Status = SyncStatus;

export const useGoogleStatus = () => useSyncStatus('google');

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
  return <SyncPage provider="google" connectStep={6}>{(st, refresh) => <GoogleSteps st={st} refresh={refresh} />}</SyncPage>;
}

function GoogleSteps({ st, refresh }: { st: Status; refresh: () => void }) {
  const toast = useToast();
  const server = st.credentialsSource === 'server';
  const current = st.connected ? 7 : st.hasCredentials ? 6 : 1;
  const connect = () => connectTo('google');
  return (
    <>
      <p className="muted small" style={{ margin: '0 4px 16px' }}>
        {server
          ? 'Les identifiants Google sont déjà configurés sur le serveur : il te reste seulement à autoriser PLWR (étape 1).'
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
