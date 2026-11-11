import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Avatar, ROLE_HINT, type Role } from '../lib/people';

export type InviteInfo = { ownerName: string; ownerColor: string; role: Role; email: string | null };

export const useInvite = (token: string | null) =>
  useQuery({ queryKey: ['invite', token], queryFn: () => api.get<InviteInfo>(`/api/invites/${encodeURIComponent(token!)}`), enabled: Boolean(token), retry: false });

export function InviteHeader({ info }: { info: InviteInfo }) {
  return (
    <div className="invite-head">
      <Avatar person={{ initial: info.ownerName.charAt(0).toUpperCase(), color: info.ownerColor, name: info.ownerName }} size={56} />
      <h1>Agenda de {info.ownerName}</h1>
      <p className="muted">
        {info.ownerName} t’invite à rejoindre son agenda. {ROLE_HINT[info.role]}.
      </p>
    </div>
  );
}

/** Invitation ouverte par une personne déjà connectée. */
export function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const q = useInvite(token);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/invites/${encodeURIComponent(token)}/accept`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      {q.isLoading && <div className="empty">Chargement…</div>}
      {q.isError && (
        <div className="card stack center">
          <h2>Invitation invalide</h2>
          <p className="muted small">Ce lien a expiré, a déjà servi ou a été désactivé. Demande un nouveau lien.</p>
          <button className="btn" onClick={onDone}>
            Ouvrir mon agenda
          </button>
        </div>
      )}
      {q.data && (
        <div className="stack">
          <InviteHeader info={q.data} />
          {error && <div className="error center">{error}</div>}
          <button className="btn primary block" onClick={accept} disabled={busy}>
            Rejoindre l’agenda
          </button>
          <button className="btn ghost block" onClick={onDone}>
            Plus tard
          </button>
        </div>
      )}
    </div>
  );
}
