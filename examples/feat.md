---
title: MDForge — moteur CodeMirror
author: Tribaud
tags: [demo, codemirror, live-preview]
---

Ce fichier exerce les fonctionnalités du **moteur CodeMirror** (branche
`experiment/codemirror`) : rendu live-preview sans réécriture de la source.

Le frontmatter ci-dessus s'affiche comme une **carte** (titre en H1, autres clés
en chips). Clique `✎` pour éditer le YAML brut, puis `✓ Terminer` pour sortir.

## Mise en forme

Du texte **gras**, *italique*, `code inline`, ~~barré~~, et un
[lien externe](https://example.com) (Ctrl/⌘ + clic pour l'ouvrir).

## Tâches (avec l'état `[~]` MDForge)

- [ ] à faire
- [~] en cours
- [x] fait

Les cases marchent aussi sur des listes **numérotées**, et le marqueur (tiret ou
numéro, avec renumérotation) s'enchaîne quand on appuie sur `Entrée` :

1. [x] **étape faite**
2. [~] étape en cours
3. [ ] étape à venir

> Le cycle de clic saute l'état orange si `mdforge.checkbox.enableInProgress`
> vaut `false`.

## Bloc de code (sélecteur de langage)

Survole le bloc : un champ apparaît en haut à droite. Choisis un langage connu
ou tape le tien.

```python
def area(r):
    return 3.14159 * r * r
```

## Déplacer un bloc

Survole n'importe quel paragraphe : une poignée `⠿` apparaît à gauche. Attrape-la
et dépose le bloc ailleurs (la barre bleue indique la cible). Essaie de déplacer
ce paragraphe au-dessus du titre « Mise en forme ».

## Tableau (rendu inline dans les cellules)

| Élément    | Formule    | Note        |
| :--------- | :--------: | ----------: |
| Cercle     | $\pi r^2$  | `area()`    |
| **Sommet** | $x_0$      | *à revoir*  |

## Alerte GitHub

> [!TIP]
> Le menu déroulant en tête de citation change le type d'alerte, ou revient à
> « — Citation (aucune alerte) ».

## Maths

Inline : $E = mc^2$. Bloc :

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Recherche & repli

`Ctrl/⌘ + F` ou le bouton 🔍 de la barre ouvre la recherche. Les flèches de la
gouttière replient les sections sous chaque titre.
