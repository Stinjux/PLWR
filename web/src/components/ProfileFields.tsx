import { useId, useMemo, useRef, useState } from 'react';
const whole = (dollars: number) => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(dollars);

export const PROFESSIONS = [
  'Administrateur·trice réseau', 'Adjoint·e administratif·ve', 'Agent·e de sécurité', 'Agent·e de service à la clientèle', 'Agriculteur·trice',
  'Ambulancier·ère paramédic', 'Analyste de données', 'Analyste financier·ère', 'Architecte', 'Avocat·e', 'Barista', 'Caissier·ère',
  'Camionneur·euse', 'Charpentier·ère-menuisier·ère', 'Chauffeur·euse', 'Chef cuisinier·ère', 'Coiffeur·euse', 'Commis d’épicerie', 'Comptable',
  'Concierge', 'Conseiller·ère en finances personnelles', 'Conseiller·ère pédagogique', 'Consultant·e', 'Courtier·ère d’assurance',
  'Courtier·ère immobilier', 'Cuisinier·ère', 'Dentiste', 'Designer UX/UI', 'Développeur·euse logiciel', 'Directeur·trice', 'Éducateur·trice à la petite enfance',
  'Électricien·ne', 'Enseignant·e', 'Entraîneur·e', 'Entrepreneur·e', 'Esthéticien·ne', 'Étudiant·e', 'Fonctionnaire', 'Gérant·e de magasin',
  'Gestionnaire de projet', 'Graphiste', 'Hygiéniste dentaire', 'Infirmier·ère', 'Infirmier·ère auxiliaire', 'Ingénieur·e', 'Journaliste',
  'Livreur·euse', 'Magasinier·ère', 'Manutentionnaire', 'Marketing et communications', 'Mécanicien·ne', 'Médecin', 'Militaire', 'Notaire',
  'Opérateur·trice de machinerie', 'Ouvrier·ère de production', 'Parajuriste', 'Parent au foyer', 'Paysagiste', 'Pharmacien·ne', 'Photographe',
  'Physiothérapeute', 'Planificateur·trice financier·ère', 'Plombier·ère', 'Policier·ère', 'Pompier·ère', 'Préposé·e aux bénéficiaires',
  'Professeur·e (cégep ou université)', 'Psychologue', 'Recruteur·euse', 'Rédacteur·trice', 'Réceptionniste', 'Représentant·e des ventes',
  'Ressources humaines', 'Retraité·e', 'Sans emploi', 'Serveur·euse', 'Soudeur·euse', 'Technicien·ne comptable', 'Technicien·ne en pharmacie',
  'Technicien·ne informatique', 'Traducteur·trice', 'Travailleur·euse autonome', 'Travailleur·euse social·e', 'Vendeur·euse',
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[·’']/g, '').toLowerCase();
const OTHER = 'Autre';

/** Liste déroulante des professions : taper affine la liste ; « Autre » permet d'écrire la sienne. */
export function ProfessionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState(value && PROFESSIONS.includes(value) ? value : '');
  const [other, setOther] = useState(Boolean(value) && !PROFESSIONS.includes(value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const options = useMemo(() => {
    const q = norm(query.trim());
    const found = q ? PROFESSIONS.filter((p) => norm(p).includes(q)) : PROFESSIONS;
    return [...found.slice(0, q ? 8 : 60), OTHER];
  }, [query]);

  function pick(opt: string) {
    setOpen(false);
    if (opt === OTHER) {
      setOther(true);
      setQuery(OTHER);
      onChange('');
      return;
    }
    setOther(false);
    setQuery(opt);
    onChange(opt);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') (e.preventDefault(), setOpen(true), setActive((a) => Math.min(options.length - 1, a + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === 'Enter' && open) (e.preventDefault(), pick(options[active]));
    else if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className="combo">
      <label className="field">
        Profession
        <input
          className="input"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
          value={query}
          placeholder="Tape pour chercher : infirm, compt, ensei…"
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
            if (!other) onChange(PROFESSIONS.find((p) => norm(p) === norm(e.target.value)) || '');
          }}
          onKeyDown={onKey}
        />
      </label>
      {open && (
        <ul className="combo-list" role="listbox" id={`${id}-list`} ref={listRef} aria-label="Professions">
          {options.map((o, i) => (
            <li
              key={o}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`${i === active ? 'active' : ''}${o === OTHER ? ' other' : ''}`}
              onMouseDown={(e) => (e.preventDefault(), pick(o))}
              onMouseEnter={() => setActive(i)}
            >
              {o === OTHER ? 'Autre (je l’écris)' : o}
            </li>
          ))}
        </ul>
      )}
      {other && (
        <label className="field" style={{ marginTop: 10 }}>
          Ta profession
          <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ex. : Technicienne en laboratoire" autoFocus />
        </label>
      )}
    </div>
  );
}

export const SALARY_MAX = 250_000;

/** Jauge du salaire annuel (0 à 250 000 $, au-delà par le champ exact). */
export function SalaryGauge({ cents, onChange, type, onType }: { cents: number; onChange: (c: number) => void; type: 'gross' | 'net'; onType: (t: 'gross' | 'net') => void }) {
  const dollars = Math.round(cents / 100);
  const pct = Math.min(100, (Math.min(dollars, SALARY_MAX) / SALARY_MAX) * 100);
  const label = dollars >= SALARY_MAX ? `${whole(SALARY_MAX)} et plus` : whole(dollars);
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="field-label">Salaire annuel</span>
        <span className="gauge-value" aria-live="polite">
          {dollars > 0 ? label : '—'}
        </span>
      </div>
      <input
        type="range"
        className="gauge-range"
        min={0}
        max={SALARY_MAX}
        step={1000}
        value={Math.min(dollars, SALARY_MAX)}
        onChange={(e) => onChange(Number(e.target.value) * 100)}
        aria-label="Salaire annuel"
        aria-valuetext={`${label} par année`}
        style={{ ['--pct' as any]: `${pct}%` }}
      />
      <div className="gauge-scale" aria-hidden="true">
        <span>0</span>
        <span>50 k</span>
        <span>100 k</span>
        <span>150 k</span>
        <span>200 k</span>
        <span>250 k+</span>
      </div>
      <div className="row" style={{ gap: 10, marginTop: 10 }}>
        <label className="field grow">
          Montant exact
          <span className="money-input">
            <input
              className="input"
              inputMode="numeric"
              value={dollars ? String(dollars) : ''}
              onChange={(e) => onChange((Number(e.target.value.replace(/\D/g, '')) || 0) * 100)}
              placeholder="62000"
              aria-label="Montant exact du salaire annuel"
            />
            <span aria-hidden="true">$</span>
          </span>
        </label>
        <div className="seg" role="group" aria-label="Brut ou net" style={{ alignSelf: 'flex-end' }}>
          <button type="button" className={type === 'gross' ? 'on' : ''} aria-pressed={type === 'gross'} onClick={() => onType('gross')}>
            Brut
          </button>
          <button type="button" className={type === 'net' ? 'on' : ''} aria-pressed={type === 'net'} onClick={() => onType('net')}>
            Net
          </button>
        </div>
      </div>
      {dollars > 0 && <div className="tiny muted">≈ {whole(Math.round(dollars / 12))} par mois {type === 'gross' ? 'avant impôts' : 'dans ton compte'}</div>}
    </div>
  );
}
