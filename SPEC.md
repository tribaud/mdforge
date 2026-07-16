# MDForge — Spécification

> Transformez VS Code en **MDForge** : un éditeur Markdown **WYSIWYG façon Typora**, au **rendu type GitHub**, fidèle à vos fichiers `.md`. Open source (MIT).

## 1. Vision & principes

- **WYSIWYG « live » type Typora** : le Markdown se rend en place ; les marqueurs de syntaxe n'apparaissent qu'au contact du curseur.
- **Rendu GitHub** : référence visuelle `github-markdown-css`, thèmes clair/sombre alignés sur VS Code.
- **Le fichier `.md` reste la source de vérité** : écritures propres, diffs git minimaux (surveiller le reformatage ProseMirror).
- **Pas de fonctions payantes** : tout est libre (contrairement à mark-sharp).
- **Pas de spécifique Hugo** (c'était le parti pris de MD-Editor, hors périmètre ici).

## 2. Moteur

- **Milkdown** (ProseMirror + remark), **headless** → on écrit nous-mêmes le thème GitHub.
- Aller-retour Markdown via **remark** (AST Markdown).
- Rendu diagrammes via le plugin **Mermaid** de Milkdown.
- Intégration VS Code : `CustomTextEditorProvider` + webview, synchro bidirectionnelle fichier ↔ webview.

## 3. Fonctionnalités (dérivées du guide mark-sharp, priorisées)

### P0 — MVP
- [ ] Ouvrir `.md` / `.markdown` dans l'éditeur WYSIWYG (custom editor + commande + menu contextuel + raccourci)
- [ ] Synchro bidirectionnelle avec le fichier et l'éditeur texte VS Code
- [ ] Titres H1–H6, gras, italique, barré, citations
- [ ] Listes ordonnées / non ordonnées, liens, images, règles horizontales
- [ ] Blocs de code avec coloration selon le langage
- [ ] Tables GFM (rendu + édition)
- [ ] **Task lists cliquables** `[ ]` / `[x]`
- [ ] **Mermaid** (rendu des diagrammes)
- [ ] **Thème GitHub** clair/sombre suivant VS Code
- [ ] KaTeX (inline `$...$` et bloc `$$...$$`)

### P1 — Différenciateurs
- [ ] **État personnalisé `[~]` « en cours »** sur les cases à cocher (+ cycle de clic configurable)
- [ ] Slash commands `/` (insertion rapide : titres, listes, table, mermaid, code…)
- [ ] GitHub Alerts `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
- [ ] Panneau Outline (plan du document)
- [ ] En-têtes repliables (collapsible headers)
- [ ] Notes de bas de page (footnotes)
- [ ] Frontmatter (rendu discret + édition)
- [ ] Réglages : police, taille, largeur de page, thème Mermaid

### P2 — Confort / avancé
- [ ] Wikilinks `[[...]]`
- [ ] Mode présentation / lecture seule
- [ ] Blocs déplaçables (drag handle)
- [ ] Texte droite-à-gauche (RTL)
- [ ] CSS personnalisé utilisateur
- [ ] Export / copie HTML

## 4. Cases à cocher — états personnalisés

Cycle de clic proposé (à valider) :

```
[ ] vide  →  [~] en cours  →  [x] fait  →  [ ] vide
```

Options envisageables (à confirmer) : `[-]` annulé, `[!]` important, `[?]` question.
Rendu visuel distinct par état (couleur / icône), tout en gardant un Markdown lisible hors MDForge.

> Note : `[ ]` et `[x]` sont standard (GFM) ; `[~]` et les autres sont une **convention personnalisée** — définie et documentée par MDForge.

## 5. Non-objectifs

- Pas de licence/activation payante, pas de télémétrie.
- Pas d'intégration Hugo/SSG.

## 6. Licence & attributions

- **MIT.**
- S'inspire des **fonctionnalités** de mark-sharp (utilisé comme cahier des charges) — **sans copier son code** (propriétaire).
- Réutilise Milkdown / remark / Mermaid (tous MIT).
