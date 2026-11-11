import { useState } from 'react';
import { api } from '../lib/api';
import { Icon, useToast } from '../components/ui';
import { Btn, Field, Line, Shot, Step, SyncPage, connectTo, copy, useSyncStatus, type SyncStatus } from '../components/GuideParts';

export const useOutlookStatus = () => useSyncStatus('outlook');

/** Import des variables : ID d'application, valeur du secret client, annuaire. */
function OutlookCredentialsForm({ st, onSaved }: { st: SyncStatus; onSaved: () => void }) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState('common');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(!st.hasCredentials || st.credentialsSource === 'server');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/outlook/credentials', { clientId, clientSecret: secret, tenant });
      toast('Identifiants Microsoft importés');
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

  if (!edit)
    return (
      <div className="banner info small" data-testid="credentials-ok">
        <Icon.check style={{ width: 18, height: 18, flex: 'none' }} />
        <span className="grow" style={{ minWidth: 0 }}>
          Identifiants importés
          <span className="block tiny muted ellipsis">
            {st.clientId} · annuaire {st.tenant}
          </span>
        </span>
        <button className="btn small" onClick={() => setEdit(true)}>
          Remplacer
        </button>
      </div>
    );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="field">
        ID d’application (client)
        <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="1a2b3c4d-…-…" autoComplete="off" spellCheck={false} />
      </label>
      <label className="field">
        Valeur du secret client
        <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Colonne « Valeur », pas « ID du secret »" autoComplete="off" spellCheck={false} />
      </label>
      <label className="field">
        Annuaire
        <input className="input" value={tenant} onChange={(e) => setTenant(e.target.value)} autoComplete="off" spellCheck={false} />
        <span className="tiny muted">Laisse « common ». Seulement si tu as choisi « Comptes de cet annuaire uniquement » à l’étape 2 : colle l’ID de l’annuaire (locataire).</span>
      </label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy || !clientId || !secret} onClick={save}>
        Importer mes identifiants
      </button>
      <div className="tiny muted">Le secret est chiffré sur le serveur et n’est jamais réaffiché.</div>
    </div>
  );
}

export function OutlookGuide() {
  return <SyncPage provider="outlook" connectStep={6}>{(st, refresh) => <OutlookSteps st={st} refresh={refresh} />}</SyncPage>;
}

function OutlookSteps({ st, refresh }: { st: SyncStatus; refresh: () => void }) {
  const toast = useToast();
  const server = st.credentialsSource === 'server';
  const current = st.connected ? 7 : st.hasCredentials ? 6 : 1;
  return (
    <>
      <p className="muted small" style={{ margin: '0 4px 16px' }}>
        {server
          ? 'L’application Microsoft est déjà configurée sur le serveur : il te reste seulement à autoriser PLWR (étape 1).'
          : 'Pour Outlook.com, Hotmail, Live et Microsoft 365. Chaque personne relie son propre Outlook avec ses propres identifiants. Fais-le sur un ordinateur ; la connexion marche ensuite partout, iPhone compris.'}
      </p>

      <div className="steps">
        {!server && (
          <>
            <Step n={1} title="Ouvrir les inscriptions d’applications Microsoft" done={current > 1} current={current === 1}>
              <ol>
                <li>
                  Ouvre{' '}
                  <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">
                    entra.microsoft.com
                  </a>{' '}
                  (ou portal.azure.com → <b>Microsoft Entra ID</b>) avec le compte Microsoft de ton agenda.
                </li>
                <li>
                  Menu <b>Applications</b> → <b>Inscriptions d’applications</b> (App registrations) → <b>Nouvelle inscription</b>.
                </li>
              </ol>
              <div className="banner small">
                <span>
                  <b>Compte personnel</b> (Outlook.com, Hotmail) : Microsoft peut d’abord te demander d’ouvrir un compte Azure gratuit, avec une vérification d’identité. Inscrire une application ne coûte rien.{' '}
                  <b>Compte du travail ou de l’école</b> : ton organisation peut bloquer cette étape ; demande alors à ton administrateur.
                </span>
              </div>
              <Shot url="entra.microsoft.com · Inscriptions d’applications">
                <strong className="shot-title">Inscriptions d’applications</strong>
                <div className="shot-actions" style={{ justifyContent: 'flex-start' }}>
                  <Btn hl>+ Nouvelle inscription</Btn>
                  <Btn ghost>Points de terminaison</Btn>
                </div>
                <Line w={90} />
                <Line w={60} />
              </Shot>
            </Step>

            <Step n={2} title="Inscrire l’application PLWR" done={current > 2} current={false}>
              <ol>
                <li>
                  Nom : <b>PLWR</b>.
                </li>
                <li>
                  Types de comptes pris en charge : <b>Comptes dans un annuaire d’organisation (multilocataire) et comptes Microsoft personnels</b>.
                </li>
                <li>
                  URI de redirection : plateforme <b>Web</b>, puis colle exactement :
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
                  <b>S’inscrire</b>. Sur la page <b>Vue d’ensemble</b>, note l’<b>ID d’application (client)</b> : tu le colleras à l’étape 5.
                </li>
              </ol>
              <Shot url="entra.microsoft.com · Inscrire une application">
                <strong className="shot-title">Inscrire une application</strong>
                <Field label="Nom" value="PLWR" />
                <div className="shot-check hl">
                  <span className="box">●</span>
                  <span>Comptes dans un annuaire d’organisation (multilocataire) et comptes Microsoft personnels</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Field label="Plateforme" value="Web" hl />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <Field label="URI de redirection" value={st.redirectUri} hl />
                  </div>
                </div>
                <div className="shot-actions">
                  <Btn hl>S’inscrire</Btn>
                </div>
              </Shot>
              <Shot url="entra.microsoft.com · PLWR · Vue d’ensemble" caption="L’ID d’application est un identifiant du type 1a2b3c4d-….">
                <strong className="shot-title">PLWR</strong>
                <Field label="ID d’application (client)" value="1a2b3c4d-5e6f-7a8b-9c0d-…" hl />
                <Field label="ID de l’annuaire (locataire)" value="…" />
              </Shot>
            </Step>

            <Step n={3} title="Choisir les autorisations (la fiche de consentement)" done={current > 3} current={false}>
              <p className="small" style={{ marginTop: 0 }}>
                Ces autorisations sont exactement ce que Microsoft te demandera d’accepter à l’étape 6.
              </p>
              <ol>
                <li>
                  Menu de l’application → <b>Autorisations d’API</b> → <b>Ajouter une autorisation</b> → <b>Microsoft Graph</b> → <b>Autorisations déléguées</b>.
                </li>
                <li>
                  Coche <code>Calendars.ReadWrite</code> et <code>offline_access</code> (<code>User.Read</code> est déjà là) → <b>Ajouter des autorisations</b>.
                </li>
              </ol>
              <Shot url="entra.microsoft.com · PLWR · Autorisations d’API" caption="offline_access garde la connexion active sans te redemander ton mot de passe.">
                <strong className="shot-title">Demander des autorisations d’API · Microsoft Graph</strong>
                <div className="shot-radio">
                  <span className="hl">Autorisations déléguées</span>
                  <span>Autorisations d’application</span>
                </div>
                <div className="shot-check hl">
                  <span className="box">✓</span>
                  <span>
                    <code>Calendars.ReadWrite</code>
                    <small className="block">Disposer d’un accès complet aux calendriers de l’utilisateur</small>
                  </span>
                </div>
                <div className="shot-check hl">
                  <span className="box">✓</span>
                  <span>
                    <code>offline_access</code>
                    <small className="block">Conserver l’accès aux données auxquelles vous lui avez donné accès</small>
                  </span>
                </div>
                <div className="shot-actions">
                  <Btn hl>Ajouter des autorisations</Btn>
                </div>
              </Shot>
            </Step>

            <Step n={4} title="Créer le secret client (ta variable secrète)" done={current > 4} current={false}>
              <ol>
                <li>
                  Menu → <b>Certificats et secrets</b> → onglet <b>Secrets client</b> → <b>Nouveau secret client</b>.
                </li>
                <li>
                  Description : <b>PLWR</b>. Expiration : <b>24 mois</b> → <b>Ajouter</b>.
                </li>
                <li>
                  <b>Copie tout de suite la colonne « Valeur »</b> (pas « ID du secret ») : Microsoft ne la montre qu’une seule fois.
                </li>
              </ol>
              <div className="banner small">
                <span>
                  Le secret expire à la date choisie. Avant l’échéance, crée-en un nouveau et importe-le de nouveau à l’étape 5 ; PLWR t’avertit s’il a expiré.
                </span>
              </div>
              <Shot url="entra.microsoft.com · PLWR · Certificats et secrets">
                <strong className="shot-title">Secrets client</strong>
                <div className="shot-table">
                  <span>Description</span>
                  <span>Expire le</span>
                  <span className="hl">Valeur</span>
                  <span>ID du secret</span>
                  <span>PLWR</span>
                  <span>dans 24 mois</span>
                  <span className="hl">Abc8Q~••••••</span>
                  <span>9f8e7d6c-…</span>
                </div>
              </Shot>
            </Step>

            <Step n={5} title="Importer tes variables dans PLWR" done={current > 5} current={false}>
              <OutlookCredentialsForm st={st} onSaved={refresh} />
            </Step>
          </>
        )}

        <Step n={server ? 1 : 6} title="Autoriser PLWR sur l’écran de Microsoft" done={st.connected} current={current === 6}>
          <ol>
            <li>
              Touche <b>Connecter Outlook</b> ci-dessous et choisis ton compte Microsoft.
            </li>
            <li>
              La fiche <b>« Autorisations demandées »</b> liste l’accès à ton calendrier : vérifie, puis <b>Accepter</b>. La mention « non vérifiée » est normale : c’est ta propre application.
            </li>
            <li>Tu reviens ici avec « Connecté ».</li>
          </ol>
          <Shot url="login.microsoftonline.com" caption="La fiche de consentement de Microsoft.">
            <strong className="shot-title">Autorisations demandées · PLWR (non vérifiée)</strong>
            <span className="small">Cette application souhaite :</span>
            <div className="shot-check">
              <span className="box">✓</span>
              <span>Disposer d’un accès complet à vos calendriers</span>
            </div>
            <div className="shot-check">
              <span className="box">✓</span>
              <span>Conserver l’accès aux données auxquelles vous lui avez donné accès</span>
            </div>
            <div className="shot-check">
              <span className="box">✓</span>
              <span>Afficher votre profil de base</span>
            </div>
            <div className="shot-actions">
              <Btn ghost>Annuler</Btn>
              <Btn hl>Accepter</Btn>
            </div>
          </Shot>
          <div className="tiny muted">Compte du travail : si Microsoft affiche « Approbation de l’administrateur requise », ton administrateur doit approuver PLWR une fois.</div>
          {st.connected ? (
            <div className="banner info small">
              <Icon.check style={{ width: 18, height: 18, flex: 'none' }} /> Connecté à {st.email || 'Outlook'}.
            </div>
          ) : (
            <button className="btn primary block" onClick={() => connectTo('outlook')} disabled={!st.hasCredentials}>
              Connecter Outlook
            </button>
          )}
          {!st.hasCredentials && <div className="tiny muted">Importe d’abord tes identifiants (étape 5).</div>}
        </Step>

        <Step n={server ? 2 : 7} title="C’est synchronisé" done={st.connected && !st.lastError} current={current === 7}>
          <ul className="bullets">
            <li>
              Tes événements Outlook arrivent dans PLWR toutes les {st.syncMinutes} minutes (et quand tu touches <b>Synchroniser maintenant</b>). Ils sont en lecture seule ici : modifie-les dans
              Outlook.
            </li>
            <li>Ce que tu crées dans PLWR part vers Outlook quelques secondes après (option ci-dessus), répétitions comprises.</li>
            <li>
              Les personnes qui partagent ton agenda voient aussi tes événements Outlook, selon l’accès que tu leur as donné. Un événement <b>privé</b> dans Outlook arrive en « Occupé seulement ».
            </li>
            <li>Les événements « toute la journée » ne sont pas importés.</li>
            <li>Tu peux relier Outlook et Google Agenda en même temps : chacun reçoit ce qui est créé dans PLWR.</li>
          </ul>
        </Step>
      </div>
    </>
  );
}
