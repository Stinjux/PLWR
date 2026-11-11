import { api } from './api';

/** Mesure d'adoption (stockée dans la base de PLWR seulement). Ne bloque jamais l'interface. */
export function track(name: 'onboarding_started' | 'explore_clicked' | 'next_action_clicked' | 'reminder_permission' | 'welcome_dismissed', props: Record<string, string | number | boolean> = {}) {
  api.post('/api/track', { name, props }).catch(() => {});
}
