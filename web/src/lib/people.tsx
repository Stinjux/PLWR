import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export type Role = 'edit' | 'view' | 'busy';
export type Access = 'owner' | Role;
export type Person = {
  id: string;
  name: string;
  initial: string;
  color: string;
  me: boolean;
  /** Mon accès à son agenda. */
  access: Access | null;
  /** Son accès à mon agenda. */
  memberRole: Role | null;
};

export const COLORS = ['blue', 'green', 'amber', 'plum', 'teal', 'rose'] as const;
export const COLOR_LABEL: Record<string, string> = { blue: 'Bleu', green: 'Vert', amber: 'Ambre', plum: 'Prune', teal: 'Sarcelle', rose: 'Rose' };

export const ROLE_LABEL: Record<Role, string> = { edit: 'Peut modifier', view: 'Peut voir', busy: 'Occupé seulement' };
export const ROLE_HINT: Record<Role, string> = { edit: 'Ajoute et modifie', view: 'Voit tous les détails', busy: 'Voit seulement les plages prises' };

export const usePeople = () => useQuery({ queryKey: ['people'], queryFn: () => api.get<Person[]>('/api/people'), staleTime: 30_000 });

/** Personnes masquées dans l'agenda (mémorisé sur cet appareil). */
export function useHiddenPeople() {
  const KEY = 'plwr.hiddenPeople';
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(hidden));
    } catch {}
  }, [hidden]);
  const toggle = useCallback((id: string) => setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id])), []);
  return { hidden, toggle };
}

export function Avatar({ person, size = 24, ring }: { person: Pick<Person, 'initial' | 'color' | 'name'>; size?: number; ring?: boolean }) {
  return (
    <span className={`avatar pc-${person.color}${ring ? ' ring' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} title={person.name} aria-hidden="true">
      {person.initial}
    </span>
  );
}

export function AvatarStack({ people, size = 20, max = 4 }: { people: Pick<Person, 'id' | 'initial' | 'color' | 'name'>[]; size?: number; max?: number }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  return (
    <span className="avatar-stack" aria-label={people.map((p) => p.name).join(', ')}>
      {shown.map((p) => (
        <Avatar key={p.id} person={p} size={size} ring />
      ))}
      {people.length > max && <span className="avatar more" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>+{people.length - max}</span>}
    </span>
  );
}
