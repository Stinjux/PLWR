import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DraftCard, ManualExpenseForm, type Draft } from './DraftCard';
import { Sheet, useToast } from './ui';

/**
 * Validation des dépenses en attente. Avec importId : revue d'une image importée (même parcours que le chatbot :
 * corriger, retirer ou confirmer chaque ligne, ou plusieurs lignes d'un coup).
 */
export function PendingSheet({ importId, onClose }: { importId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = importId ? ['import', importId] : ['drafts'];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => (importId ? api.get<{ import: any; drafts: Draft[] }>(`/api/imports/${importId}`) : { import: null, drafts: await api.get<Draft[]>('/api/drafts') }),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const drafts = q.data?.drafts || [];
  const imp = q.data?.import;
  const pending = drafts.filter((d) => d.status === 'pending');
  // Par défaut : lignes complètes, sans doublon signalé
  const sel = selected ?? new Set(pending.filter((d) => !d.duplicates.length && !d.importDuplicate && !d.missing.length).map((d) => d.id));
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  async function confirmSelected() {
    if (busy || !sel.size) return;
    setBusy(true);
    try {
      const r = await api.post<{ results: any[] }>('/api/drafts/confirm-many', { ids: [...sel] });
      const ok = r.results.filter((x) => x.ok).length;
      const dup = r.results.filter((x) => x.duplicate).length;
      const err = r.results.filter((x) => !x.ok && !x.duplicate).map((x) => x.error);
      toast(`${ok} ligne(s) confirmée(s)${dup ? ` · ${dup} doublon(s) non enregistré(s)` : ''}${err.length ? ` · ${err[0]}` : ''}`);
      setSelected(null);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={importId ? 'Vérifier l’import' : 'Dépenses à valider'}
      onClose={onClose}
      tall
      footer={
        pending.length > 0 ? (
          <button className="btn primary block" onClick={confirmSelected} disabled={busy || !sel.size} data-testid="confirm-selected">
            Confirmer la sélection ({sel.size})
          </button>
        ) : (
          <button className="btn block" onClick={onClose}>
            Terminé
          </button>
        )
      }
    >
      <div className="stack">
        {imp && (
          <div className="stack" style={{ gap: 6 }}>
            {imp.hasImage && <img className="thumb" style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }} src={`/api/imports/${imp.id}/image`} alt="Image importée" />}
            {imp.redactions > 0 && <div className="banner info small">🔒 {imp.redactions} numéro(s) de carte masqué(s) avant l’envoi au service de lecture.</div>}
            {imp.duplicateOf && <div className="banner danger small">Cette image a déjà été importée. Les lignes déjà enregistrées sont signalées et désélectionnées.</div>}
            {imp.status === 'failed' && (
              <div className="banner danger small" data-testid="import-error">
                Lecture impossible : {imp.error}. Termine la saisie manuellement ci-dessous.
              </div>
            )}
            {!imp.hasImage && imp.imageDeletedAt && <div className="tiny muted">Image supprimée après validation.</div>}
          </div>
        )}
        {q.isLoading && <div className="empty">Chargement…</div>}
        {!q.isLoading && drafts.length === 0 && !imp && <div className="empty">Aucune dépense en attente 🎉</div>}
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            from="budget"
            onChanged={() => refresh()}
            selectable
            selected={sel.has(d.id)}
            onSelect={(v) => {
              const s = new Set(sel);
              v ? s.add(d.id) : s.delete(d.id);
              setSelected(s);
            }}
          />
        ))}
        {imp && (imp.status === 'failed' || manual) ? (
          <ManualExpenseForm importId={imp.id} onCreated={() => (setManual(false), refresh())} />
        ) : (
          imp && (
            <button className="btn" onClick={() => setManual(true)}>
              Ajouter une ligne manuellement
            </button>
          )
        )}
      </div>
    </Sheet>
  );
}
