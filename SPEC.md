# MDForge — Spécification

> Transformez VS Code en **MDForge** : un éditeur Markdown **WYSIWYG façon Typora**, au **rendu type GitHub**, fidèle à vos fichiers `.md`. Open source (MIT).

## 1. Vision & principes

- **WYSIWYG « live » type Typora** : le Markdown se rend en place ; les marqueurs de syntaxe n'apparaissent qu'au contact du curseur.
- **Rendu GitHub** : référence visuelle `github-markdown-css`, thèmes clair/sombre alignés sur VS Code.
- **Le fichier `.md` reste la source de vérité** : le document EST le texte Markdown (CodeMirror), aucune réécriture → diffs git minimaux (un caractère modifié = un caractère de diff).
- **Pas de fonctions payantes** : tout est libre (contrairement à mark-sharp).
- **Pas de spécifique Hugo** (c'était le parti pris de MD-Editor, hors périmètre ici).

## 2. Moteur

- **CodeMirror 6** en « live preview » façon Obsidian : le document est le texte Markdown ; l'analyse Lezer (`@lezer/markdown` + GFM) alimente des décorations qui masquent les marqueurs et stylent le contenu. On écrit nous-mêmes le thème GitHub.
- Aucune sérialisation : les éditions modifient directement le texte source.
- Rendu diagrammes via la lib **Mermaid** (import dynamique), maths via **KaTeX**.
- Intégration VS Code : `CustomTextEditorProvider` + webview, synchro bidirectionnelle fichier ↔ webview.

## 3. Fonctionnalités (dérivées du guide mark-sharp, priorisées)

> Statut : `[x]` implémenté · `[~]` partiel · `[ ]` à faire.

### P0 — MVP
- [x] Ouvrir `.md` / `.markdown` dans l'éditeur WYSIWYG (custom editor + commande + menu contextuel + raccourci)
- [x] Synchro bidirectionnelle avec le fichier et l'éditeur texte VS Code
- [x] Titres H1–H6, gras, italique, barré, citations
- [x] Listes ordonnées / non ordonnées, liens, images, règles horizontales *(insertion d'images : coller / glisser / parcourir + popup d'édition chemin & alt)*
- [x] Blocs de code avec coloration selon le langage *(Shiki, thèmes GitHub)*
- [x] Tables GFM (rendu + édition)
- [x] **Task lists cliquables** `[ ]` / `[x]`
- [x] **Mermaid** (rendu + édition avec coloration du source)
- [x] **Thème GitHub** clair/sombre suivant VS Code
- [x] KaTeX (inline `$...$` et bloc `$$...$$`, éditables)

### P1 — Différenciateurs
- [x] **État personnalisé `[~]` « en cours »** sur les cases à cocher (cycle configurable)
- [x] Slash commands `/` (titres, listes, task, quote, code, divider, table, mermaid)
- [x] GitHub Alerts `[!NOTE]`/`[!TIP]`/`[!IMPORTANT]`/`[!WARNING]`/`[!CAUTION]` + **menu de type** sur tout blockquote
- [x] **Barre d'outils de sélection** (gras/italique/barré/code + P/H1-H3/quote/liste, toggles, raccourcis en tooltip)
- [x] Panneau Outline (arborescence **repliable**)
- [x] En-têtes repliables *(outline repliable + pliage in-document via chevron)*
- [x] Notes de bas de page (footnotes) *(clic référence → définition)*
- [x] Frontmatter (barre discrète + édition YAML, `title` → H1)
- [x] Réglages : police, taille, largeur de page ; **thème Mermaid dédié** (auto / default / dark / neutral / forest) ; images (dossier, nommage, hash, style de lien)

### P2 — Confort / avancé
- [x] Wikilinks `[[...]]` *(cliquables ; brackets encore visibles en édition)*
- [x] Mode présentation / lecture seule *(commande + barre d'état + raccourci)*
- [x] Blocs déplaçables (drag handle)
- [x] Barre d'outils supérieure (insérer/éditer image, localiser les assets, renommer la note, présentation, réglages)
- [x] Assets façon vault : nommage `NoteName-<hash>`, localisation des images distantes, réconciliation des noms au renommage
- [ ] Texte droite-à-gauche (RTL)
- [ ] CSS personnalisé utilisateur
- [ ] Export / copie HTML

### Idées suivantes (backlog)
- [ ] Masquer les marqueurs `[[ ]]` des wikilinks en édition/lecture
- [ ] Réduire le clignotement de la barre d'outils
- [ ] Alléger le bundle Shiki (liste de langages)
- [ ] Alertes : marqueur `[!TYPE]` sur sa propre ligne (parité GitHub stricte)

## 4. Cases à cocher — états personnalisés

Cycle de clic **implémenté** :

```
[ ] vide  →  [~] en cours  →  [x] fait  →  [ ] vide
```

L'étape « en cours » est activable/désactivable via `mdforge.checkbox.enableInProgress`
(sinon le cycle est vide ↔ fait). États supplémentaires possibles plus tard
(`[-]` annulé, `[!]` important, `[?]` question) — non implémentés.

> Note : `[ ]` et `[x]` sont standard (GFM) ; `[~]` est une **convention
> personnalisée** MDForge (round-trip assuré : marqueur détecté au parse,
> réinjecté à la sérialisation).

## 5. Non-objectifs

- Pas de licence/activation payante, pas de télémétrie.
- Pas d'intégration Hugo/SSG.

## 6. Licence & attributions

- **MIT.**
- S'inspire des **fonctionnalités** de mark-sharp (utilisé comme cahier des charges) — **sans copier son code** (propriétaire).
- Réutilise CodeMirror 6 / Lezer / Mermaid / KaTeX (tous MIT).
