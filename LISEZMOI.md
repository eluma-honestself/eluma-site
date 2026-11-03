# eluma : avis validés par email

## Contenu du dossier
- `site/index.html` : le site
- `netlify/functions/` : les 3 scripts (réception d'un avis, page de validation, liste des avis publiés)
- `netlify.toml` et `package.json` : réglages pour Netlify

## Réglages à faire une seule fois dans Netlify
Dans *Site configuration → Environment variables*, ajouter :

| Nom | Valeur |
|---|---|
| `RESEND_API_KEY` | la clé créée sur resend.com (commence par `re_`) |
| `REVIEW_SECRET` | une longue phrase secrète, au moins 16 caractères, que personne ne connaît |
| `NOTIFY_EMAIL` | facultatif, `eluma.honestself@gmail.com` par défaut |

Le compte Resend doit être créé avec l'adresse eluma.honestself@gmail.com : sans nom de domaine vérifié, Resend n'envoie qu'à l'adresse du compte.

## Fonctionnement
1. Un client laisse un avis (la note est obligatoire).
2. Un email arrive avec l'avis et une traduction anglaise proposée.
3. « Publier » ouvre une page où tu peux corriger la traduction puis confirmer. L'avis apparaît alors sur le site, à la suite des autres.
4. « Refuser » ouvre une page de confirmation. L'avis n'est jamais affiché.

Les 5 premiers avis restent écrits dans `site/index.html`.
