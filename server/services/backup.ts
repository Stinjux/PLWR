import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { db, get } from '../db.ts';
import { config } from '../config.ts';

/**
 * Sauvegardes de la base SQLite : une copie cohérente par jour (VACUUM INTO) dans DATA_DIR/backups,
 * les 7 plus récentes gardées. Elles protègent contre une erreur ou une corruption ;
 * contre la perte du serveur, il faut aussi télécharger une sauvegarde de temps en temps (Réglages).
 */
const KEEP = 7;
export const backupDir = () => path.join(config.dataDir, 'backups');

function vacuumInto(file: string) {
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

export function backupNow(): string {
  fs.mkdirSync(backupDir(), { recursive: true });
  const file = path.join(backupDir(), `plwr-${DateTime.now().setZone(config.defaultTimezone).toISODate()}.sqlite`);
  vacuumInto(file);
  for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(backupDir(), old.name), { force: true });
  return file;
}

export function listBackups() {
  try {
    return fs
      .readdirSync(backupDir())
      .filter((f) => /^plwr-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(backupDir(), name));
        return { name, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch {
    return [];
  }
}

/** Copie fraîche à télécharger (fichier temporaire, effacé après lecture). */
export function backupBuffer(): Buffer {
  const tmp = path.join(os.tmpdir(), `plwr-export-${process.pid}-${Date.now()}.sqlite`);
  vacuumInto(tmp);
  try {
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Le premier compte créé administre l'instance (sauvegardes, état du stockage). */
export function isAdmin(userId: string) {
  return get<{ id: string }>('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1')?.id === userId;
}

export function startBackups() {
  const today = () => `plwr-${DateTime.now().setZone(config.defaultTimezone).toISODate()}.sqlite`;
  const tick = () => {
    if (!get('SELECT 1 FROM users LIMIT 1')) return;
    if (listBackups().some((b) => b.name === today())) return;
    try {
      backupNow();
    } catch (e) {
      console.error('[sauvegarde] échec :', e instanceof Error ? e.message : e);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60_000).unref(); // vérifie chaque heure, une copie par jour
}
