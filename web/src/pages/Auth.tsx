import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { InviteHeader, useInvite } from './Invite';

export function Auth({ onDone, invite }: { onDone: () => void; invite?: string | null }) {
  const [status, setStatus] = useState<{ hasUsers: boolean; signupOpen: boolean } | null>(null);
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
  const canRegister = Boolean(info) || Boolean(status?.signupOpen);
  return (
    <div className="auth">
      {info ? (
        <InviteHeader info={info} />
      ) : (
        <div className="center" style={{ marginBottom: 24 }}>
          <img src="/icon.svg" alt="" width={64} height={64} />
          <h1>PLWR</h1>
          <div className="muted small">Agenda, objectifs et budget</div>
        </div>
      )}
      {invite && inv.isError && <div className="banner danger small" style={{ marginBottom: 12 }}>Ce lien d’invitation a expiré ou a été désactivé. Demande un nouveau lien.</div>}
      <form className="card stack" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Connexion' : 'Créer mon compte'}</h2>
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
        <button className="btn primary" disabled={busy}>
          {mode === 'login' ? (info ? 'Se connecter et rejoindre' : 'Se connecter') : info ? 'Créer le compte et rejoindre' : 'Créer le compte'}
        </button>
        {canRegister && status?.hasUsers && (
          <button type="button" className="btn ghost small" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Créer un compte' : 'J’ai déjà un compte'}
          </button>
        )}
      </form>
    </div>
  );
}
