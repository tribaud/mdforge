---
title: Coller depuis le presse-papier
tags: [test, presse-papier, html]
author: Thierry Baud
date: 2026-09-07
---

Bac à sable pour les collages. Le contenu d'un navigateur, de Word ou de OneNote
arrive en HTML : MDForge le convertit en Markdown, rapatrie les images dans le
dossier d'assets et retraduit les maths MathML en `$…$`.

## Ce qu'il y a à vérifier en collant ici

- [ ] Les titres, le gras, l'italique et les listes gardent leur structure.
- [ ] Une liste numérotée imbriquée reste imbriquée.
- [ ] Un tableau reste un tableau GFM.
- [ ] Les images atterrissent dans `assets/` et non en `data:` dans le texte.
- [ ] Une formule copiée depuis une page web devient du LaTeX.
- [ ] Les notes de bas de page sont renumérotées par section.

> [!TIP]
> Le bouton `🐛` de la barre d'outils vide le presse-papier dans un onglet — tous
> les types annoncés et leurs contenus — sans consommer le collage. C'est par là
> qu'on commence quand une application encode son contenu autrement que prévu.

## Collages
