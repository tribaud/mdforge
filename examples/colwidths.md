# Largeurs de colonnes

Les largeurs vivent dans un commentaire HTML au-dessus du tableau. Leur **somme**
est la largeur du tableau : `[10,60,15,15]` occupe toute la colonne de texte.

<!--[10,60,15,15]-->
| Indice | Rédacteur                   | Objet          | Date       |
| ------ | --------------------------- | -------------- | ---------- |
| 1      | Josoa RASOLOFONOMENJANAHARY | Initialisation | 14/08/2026 |

Une somme inférieure à 100 donne un tableau plus étroit — ici 45 % :

<!--[10,20,15]-->
| A | B | C |
| - | - | - |
| 1 | 2 | 3 |

Sans commentaire, le tableau occupe toute la largeur (colonnes ajustées au
contenu) ; glisser sa bordure droite écrit sa largeur.

| A | B | C |
| - | - | - |
| 1 | 2 | 3 |
