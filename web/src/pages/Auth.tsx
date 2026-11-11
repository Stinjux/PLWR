import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { InviteHeader, useInvite } from './Invite';
import { Seg } from '../components/ui';

export function Auth({ onDone, invite }: { onDone: () => void; invite?: string | null }) {
  const [status, setStatus] = useState<{ hasUsers: boolean; signupOpen: boolean; users: number; maxUsers: number; full: boolean; persistent: boolean } | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [samples, setSamples] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = useInvite(invite || null);
  const info = inv.data;
  useEffect(() => {
    api.get('/api/auth/status').then((s) => {
      setStatus(s);
      if (!s.hasUsers) setMode('register');
    });
  }, []);
  // Une invitation valide ouvre l'inscription (même fermée) et propose le courriel invité
  useEffect(() => {
    if (!info) return;
    setMode('register');
    setSamples(false);
    if (info.email) setEmail(info.email);
  }, [info]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await api.post('/api/auth/login', { email, password });
        if (info && invite) {
          try {
            await api.post(`/api/invites/${encodeURIComponent(invite)}/accept`);
          } catch {
            /* déjà membre ou invitation destinée à un autre courriel : l'agenda s'ouvre quand même */
          }
        }
      } else await api.post('/api/auth/register', { email, password, name, samples, invite: info ? invite : undefined });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const canRegister = (Boolean(info) || Boolean(status?.signupOpen)) && !status?.full;
  return (
    <div className="auth">
      {info ? (
        <InviteHeader info={info} />
      ) : (
        <div className="auth-head">
          <img src="/icon.svg" alt="" width={72} height={72} />
          <h1>PLWR</h1>
          <p className="muted">Ton temps et ton argent, au même endroit.</p>
        </div>
      )}
      {status && !status.persistent && (
        <div className="banner danger small" role="alert" style={{ marginBottom: 12 }}>
          <span>
            <b>Données non sauvegardées sur ce serveur.</b> Elles seront effacées à la prochaine mise à jour. La personne qui administre PLWR doit ajouter un volume Railway (Réglages → Données et
            sauvegardes).
          </span>
        </div>
      )}
      {invite && inv.isError && <div className="banner danger small" style={{ marginBottom: 12 }}>Ce lien d’invitation a expiré ou a été désactivé. Demande un nouveau lien.</div>}
      {status?.hasUsers && canRegister && (
        <div style={{ marginBottom: 12 }}>
          <Seg
            full
            label="Connexion ou inscription"
            value={mode}
            onChange={(m) => (setMode(m), setError(null))}
            options={[
              ['login', 'Connexion'],
              ['register', 'Créer un compte'],
            ]}
          />
        </div>
      )}
      <form className="card stack auth-card" onSubmit={submit}>
        <h2>{mode === 'login' ? (info ? 'Connecte-toi pour rejoindre' : 'Bon retour') : status?.hasUsers ? 'Créer mon compte' : 'Créer le premier compte'}</h2>
        {mode === 'register' && (
          <label className="field">
            Prénom
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
          </label>
        )}
        <label className="field">
          Courriel
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          Mot de passe {mode === 'register' && <span className="tiny">(10 caractères minimum)</span>}
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} />
        </label>
        {mode === 'register' && !info && (
          <label className="row small">
            <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} /> Ajouter quelques exemples (supprimables)
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || (mode === 'register' && !canRegister && Boolean(status?.hasUsers))}>
          {mode === 'login' ? (info ? 'Se connecter et rejoindre' : 'Se connecter') : info ? 'Créer le compte et rejoindre' : 'Créer le compte'}
        </button>
        <p className="tiny muted center" style={{ margin: 0 }}>
          Tu restes connecté·e sur cet appareil tant que tu utilises PLWR.
        </p>
      </form>
      {status?.hasUsers && (
        <p className="tiny muted center" style={{ marginTop: 14 }} data-testid="seats">
          {status.full ? `Toutes les places sont prises (${status.maxUsers} comptes).` : `${status.users} compte${status.users > 1 ? 's' : ''} sur ${status.maxUsers} · ${status.maxUsers - status.users} place${status.maxUsers - status.users > 1 ? 's' : ''} libre${status.maxUsers - status.users > 1 ? 's' : ''}`}
          {!status.full && !status.signupOpen && !info && ' · sur invitation seulement'}
        </p>
      )}
    </div>
  );
}
