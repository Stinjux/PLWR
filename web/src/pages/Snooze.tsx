import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { time } from '../lib/format';

/** Page ouverte en touchant une notification sans boutons d'action (iPhone) : propose « Reporter ». */
export function Snooze() {
  const [p] = useSearchParams();
  const token = p.get('t');
  const n = p.get('n');
  const url = p.get('url') || '/';
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function snooze(minutes: number) {
    try {
      const r = token ? await api.post('/api/push/snooze', { token, minutes }) : await api.post(`/api/notifications/${n}/snooze`, { minutes });
      setDone(`Rappel reporté à ${time(r.fireAt)}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="auth">
      <div className="card stack">
        <h1>🔔 {p.get('titre') || 'Rappel'}</h1>
        {done ? (
          <div className="banner info">{done}</div>
        ) : (
          <>
            <div className="muted small">Reporter ce rappel :</div>
            <div className="row wrap">
              {[10, 30, 60].map((m) => (
                <button key={m} className="btn" onClick={() => snooze(m)}>
                  {m < 60 ? `${m} min` : '1 h'}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <a className="btn primary" href={url.startsWith('/') ? url : '/'}>
          Ouvrir
        </a>
      </div>
    </div>
  );
}
