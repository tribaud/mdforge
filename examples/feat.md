---
title: MDForge — moteur CodeMirror
author: Tribaud
tags: [demo, codemirror, live-preview]
---

Ce fichier exerce les fonctionnalités du **moteur CodeMirror** (branche `experiment/codemirror`) : rendu live-preview sans réécriture de la source.

Le frontmatter ci-dessus s'affiche comme une **carte** (titre en H1, autres clés en chips). Clique `✎` pour éditer le YAML brut, puis `✓ Terminer` pour sortir.

## Mise en forme

Du texte **gras**, *italique*, `code inline`, ~~barré~~, et un [lien externe](https://example.com) (Ctrl/⌘ + clic pour l'ouvrir).

## Tâches (avec l'état `[~]` MDForge)

- [ ] à faire
- [~] en cours
- [x] fait

Les cases marchent aussi sur des listes **numérotées**, et le marqueur (tiret ou numéro, avec renumérotation) s'enchaîne quand on appuie sur `Entrée` :

1. [x] **étape faite**
2. [~] étape en cours
3. [ ] étape à venir

> Le cycle de clic saute l'état orange si `mdforge.checkbox.enableInProgress`
> vaut `false`.

## Bloc de code (sélecteur de langage)

Survole le bloc : un champ apparaît en haut à droite. Choisis un langage connu ou tape le tien.

```python
def area(r):
    return 3.14159 * r * r
```

## Déplacer un bloc

Survole n'importe quel paragraphe : une poignée `⠿` apparaît à gauche. Attrape-la et dépose le bloc ailleurs (la barre bleue indique la cible). Essaie de déplacer ce paragraphe au-dessus du titre « Mise en forme ».

## Tableau (les cellules rendent leur contenu)

<!--[37,25,38]-->
| Élément    | Formule    | Note        |
| :--------- | :--------: | ----------: |
| Cercle     | $\pi r^2$  | `area()`    |
| **Sommet** | $x_0$      | *à revoir*  |

Une cellule accepte tout ce qu'accepte une ligne de texte — **image**, Markdown imbriqué, HTML brut, maths, wikilink, et un pipe échappé `\|` :

<!--[38,62]-->
| Ce qu'on met      | Rendu attendu                                             |
| :---------------- | :-------------------------------------------------------- |
| Image locale      | ![Logo MDForge](assets/mdforge-icon.png)                  |
| Image `data:`     | ![carré](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iOCIgZmlsbD0iIzU4YTZmZiIvPjwvc3ZnPg==) |
| Markdown imbriqué | **gras avec [un lien](https://example.com)**, `code`, ~~barré~~ |
| HTML brut         | <b>gras</b>, <span style="color:#d29922">couleur</span><br>et un saut de ligne |
| Maths             | $\sqrt{a^2 + b^2}$                                        |
| Wikilink          | [[Une autre note]]                                        |
| Pipe échappé      | `a \| b` reste dans la même cellule                       |

Survole une cellule : un `✎` apparaît dans son coin (ou double-clique). Le tableau **reste affiché** et la source de cette seule cellule s'ouvre dans un champ au-dessus, la cellule en cours étant surlignée. `Entrée` valide, `Échap` annule, `Tab` passe à la cellule suivante. Le `✎ Éditer` du bloc, lui, ouvre la source du tableau entier avec la barre d'outils de structure.

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

`Ctrl/⌘ + F` ou le bouton 🔍 de la barre ouvre la recherche.

Le repli vit dans la marge gauche, sur la ligne du bloc concerné (survole un titre pour les voir, chaque contrôle a son infobulle) :

- `⠿` — clique pour **sélectionner** le bloc (un titre prend toute sa section), glisse pour le **déplacer** ;
- `▾` — **replier** cette section. Une section repliée garde un `▸` bleu affiché en permanence : clique-le pour la rouvrir ;
- `»` — sur un titre seulement : **replier tout le niveau** (« Replier les 3 titres H2 du document »), les autres niveaux ne bougeant pas. Une fois le niveau replié, le même bouton le rouvre.

## Numéros de ligne, justification, reformatage

Les numéros de ligne sont ceux de la **source** (réglage `mdforge.lineNumbers` pour les masquer). Les lignes vides étant compactées à l'affichage, elles n'ont pas de numéro.

Le bouton `¶` **reformate** le document : il supprime les sauts de ligne en trop et, tant que `mdforge.format.paragraphs` vaut `oneLine` (le défaut), regroupe chaque paragraphe sur une seule ligne. Coche `mdforge.format.onSave` pour que ce soit fait à chaque sauvegarde. C'est ce regroupement qui rend `mdforge.textAlign: justify` visible : justifier n'étire jamais la dernière ligne d'un bloc, et chaque ligne de la source en est une.
