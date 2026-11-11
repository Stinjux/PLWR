# Maquette — agenda partagé

Maquette de design (pas encore implémentée dans `web/`) pour rendre l'agenda accessible à plusieurs personnes.

Canevas en ligne : https://claude.ai/artifact/6pZuNJsT1oQRhvHgBajsvb

| Fichier | Écran |
|---|---|
| `Main.dc.html` | iPhone · Jour : filtres par personne, pastilles de la semaine, chronologie colorée par personne |
| `Event.dc.html` | iPhone · Événement : participants, statut, visibilité (détails / occupé seulement) |
| `Share.dc.html` | iPhone · Partager : invitation par courriel, rôles (Peut modifier / Peut voir / Occupé seulement), lien d'invitation |
| `Week.dc.html` | Ordinateur · Semaine : personnes à cocher, grille 7 jours ; s'adapte au téléphone |
| `canvas.json` | Disposition des écrans sur le canevas |

Style : police système Apple (SF, secours Inter), fond `#F7F7F5`, encre `#1C1C1E`, une couleur par personne
(bleu `#2563EB`, vert `#2F7A5F`, ambre `#A65A12`, prune `#7A4FB8`) avec teinte claire pour les blocs.
