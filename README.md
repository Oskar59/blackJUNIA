# Blackjack entre amis

Site de blackjack multijoueur (jusqu'à **10 joueurs** par table), avec comptes,
statistiques et classement. Node.js + Express + Socket.io, sans base de données
externe (stockage dans un simple fichier JSON) : facile à déployer sur
n'importe quel hébergeur Node.

## Lancer en local

```bash
npm install
npm start
```

Puis ouvrez `http://localhost:3000`. Créez un compte, créez une table, et
partagez le code à 5 lettres affiché à vos amis pour qu'ils vous rejoignent
(chacun doit se créer son propre compte).

## Mettre le site en ligne

Le plus simple : un hébergeur Node.js gratuit ou peu cher qui garde le
processus actif en continu (nécessaire pour le temps réel Socket.io) :
**Render**, **Railway** ou **Fly.io**. Étapes générales (identiques sur les
trois, à quelques détails près) :

1. Poussez ce dossier dans un dépôt Git (GitHub, par ex.).
2. Sur l'hébergeur, créez un nouveau "Web Service" et pointez-le vers ce dépôt.
3. Build command : `npm install` — Start command : `npm start`.
4. Définissez une variable d'environnement `SESSION_SECRET` avec une chaîne
   aléatoire longue (par exemple générée avec `openssl rand -hex 32`) — c'est
   ce qui sécurise les sessions de connexion.
5. Une fois déployé, l'hébergeur vous donne une URL publique (ex.
   `https://votre-site.onrender.com`) : c'est le lien à partager à vos amis.

⚠️ Les données (comptes, jetons, statistiques) sont stockées dans
`data/db.json` sur le disque du serveur. Sur certains hébergeurs gratuits, le
disque n'est pas persistant entre les redéploiements — si vous voulez que les
comptes survivent dans la durée, choisissez une offre avec un disque
persistant (Render et Railway proposent des volumes persistants, parfois
payants).

## Simplifications volontaires (premier jet)

Pour livrer un site qui fonctionne bien plutôt qu'une usine à gaz, quelques
choix ont été faits :

- **Pas de séparation des mains (split)** : seuls tirer / rester / doubler
  sont disponibles.
- **Sabot neuf à chaque manche** (4 jeux mélangés) plutôt qu'un comptage réel
  des cartes au fil du temps.
- **Recharge de jetons** : un joueur à 0 jeton peut se recréditer 500 jetons
  manuellement (bouton dédié), pour ne pas bloquer une soirée entre amis.
- **Stockage JSON simple** plutôt qu'une vraie base de données — largement
  suffisant pour un groupe d'amis, et beaucoup plus facile à déployer (aucune
  dépendance native à compiler).
- **Reconnexion** : si quelqu'un ferme l'onglet, il peut revenir avec le même
  code de table et son même compte pour reprendre sa place.

Tout cela peut être étendu (split, historique de mains détaillé, plusieurs
tables privées avec mot de passe, avatars, etc.) — dites-moi ce que vous
voulez ajouter en premier.
