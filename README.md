# Blindtest

**Un blindtest sur ta propre musique.** Tu choisis d'où vient ta musique, tu écoutes un extrait, tu trouves l'artiste, le titre, l'album, l'année. Ensuite tu défies tes potes sur tes goûts.

Quatre jeux :

- **Blindtest** : un extrait, et tu trouves l'artiste, le titre, l'album, l'année.
- **Pochette surprise** : une pochette de tes albums, pixelisée, de plus en plus nette à chaque essai.
- **Qui écoute ça ?** : à plusieurs, chacun sur son téléphone, chacun apporte 15 titres ; à qui est l'extrait ?
- **Feat sur feat** : un artiste de ta musique ; qui a fait un feat avec lui ? Puis avec le suivant, et ainsi de suite.

👉 **Jouer : https://matthiasgermain.github.io/own_blindtest/**

Pas d'appli à installer, ça marche sur téléphone comme sur ordinateur.

---

## D'où vient la musique

| Source | Ce qu'il faut | Ce qu'on joue |
| --- | --- | --- |
| **Deezer** | Le lien de ton profil public, sans mot de passe | Ton top 100, tes coups de cœur, tes playlists |
| **Fichier** | L'historique que Spotify ou YouTube Music (Google Takeout, format JSON) t'envoient sur demande (ZIP) | Tes titres les plus écoutés, depuis ton premier jour |
| **Spotify** | Un compte Premium ajouté comme testeur | Tes titres likés, tes tops, tes playlists |

Avec Deezer et le fichier, le son vient des extraits Deezer de 30 secondes. Avec la connexion Spotify, il passe par le lecteur Spotify (Premium, Chrome ou Edge sur ordinateur). Spotify limite cette connexion à 5 testeurs.

## Comment on joue

- **Deux modes.** *Classique* : un nombre de titres fixé à l'avance. *Mort subite* : tu continues tant que tu trouves l'artiste ou le titre.
- **Deux façons de répondre.** *À choisir* (par défaut sur téléphone) : une question à la fois, artiste puis titre puis album, avec 4 propositions et un seul essai. Une fois l'artiste passé, les titres et albums proposés sont tous les siens, d'abord ceux de ta musique : il faut vraiment reconnaître le morceau. Les années viennent à la fin, sur un curseur. *À taper* : il faut tout écrire, les fautes de frappe sont tolérées.
- **Des questions qui dépendent de la source.** Artiste, titre, album, année de sortie, année où tu l'as liké, année où tu l'as découvert.
- **Partage et défis.** Ton résultat se partage en carrés (🟧 tout bon, 🟫 en partie, ⬛ raté). Le lien contient la partie complète : ton pote rejoue les mêmes titres et doit battre ton score, sans compte.
- **Feat sur feat.** Un jeu à part sur l'accueil, en solo : tu choisis ta musique (profil Deezer ou historique), le jeu part d'un artiste que tu écoutes. Tu tapes un artiste qui a fait un featuring avec lui, il devient le suivant, et ainsi de suite : 30 secondes par feat, jamais deux fois le même artiste. Deezer arbitre (un feat compte quand un titre crédite les deux artistes) et le titre trouvé se fait entendre. À la fin, la chaîne, ce que tu aurais pu dire, et un lien pour défier un pote depuis le même artiste. Pas de Spotify ici : ses règles pour les développeurs interdisent les jeux.
- **Pochette surprise.** Un jeu à part sur l'accueil : tu choisis ta musique (profil Deezer, historique ou Spotify), puis 5 pochettes de tes albums, 6 essais chacune. Chaque essai rend la pochette plus nette et donne un indice : l'année, le genre, les initiales de l'artiste, puis un extrait de 5 secondes. Mêmes carrés à partager (🟧 trouvé, 🟫 bon artiste, ⬛ raté), avec un lien vers les mêmes pochettes.
- **Qui écoute ça ?** Un extrait passe sur chaque téléphone (ou seulement sur celui de l'hôte si tout le monde est dans la même pièce), avec un décompte 3, 2, 1 en option. Chacun devine à qui est le titre et lequel c'est ; la révélation montre qui a voté pour qui, puis un podium avec des titres (« Le plus prévisible », « Âmes sœurs musicales »…).

## Vie privée

En solo, tout se passe dans le navigateur : pas de compte, pas de serveur, et ton historique ne quitte jamais ton appareil. Seule exception, les salles « Qui écoute ça ? » : les 15 titres que tu y apportes (artiste, titre, album, pochette) et ton pseudo passent par le serveur des salles, qui les efface 2 heures après la dernière partie lancée. La mesure d'audience, si elle est activée, n'utilise aucun cookie et ne reçoit que des faits de partie (source, mode, tranche de score), jamais un nom, un profil ou un titre.

---

## Auteur

Conçu et développé par **Matthias Germain**.

- Portfolio : https://matthias-germain.vercel.app
- GitHub : https://github.com/MatthiasGermain

Une idée, un bug ? Ouvre une [issue](https://github.com/MatthiasGermain/own_blindtest/issues).

Le code est sous licence [MIT](LICENSE).

---

## Pour les développeurs

Site statique en JavaScript, sans dépendance ni étape de build.

```
index.html     écrans, styles (DA « Disco grain »)
util.js        petits outils communs ($, stockage, mélange, partage)
app.js         écrans, bouton retour, sources, blindtest solo, partage et défis, accueil
spotify.js     connexion Spotify (OAuth PKCE), API avec pauses en cas de blocage, lecteur Premium
deezer.js      API publique Deezer (JSONP), profils, albums, titres phares et featurings d'un artiste, lecteur d'extraits
history.js     lecture des exports Spotify et YouTube Music (ZIP ou JSON)
scoring.js     barème (textes tolérants, années, artistes multiples)
challenge.js   liens de défi du blindtest (JSON compressé dans l'URL)
cover.js       « Pochette surprise » : choix de la musique, pochettes pixelisées, indices, défis (#p=…)
feat.js        « Feat sur feat » : choix de la musique, artiste de départ, chrono, vérification des feats, défis (#f=…)
room.js        salles « Qui écoute ça ? » : créer, rejoindre, salon, musique de chacun, manches
stats.js       mesure d'audience sans cookies (Umami ou GoatCounter)
config.js      Client ID Spotify, mesure d'audience, adresse du serveur des salles
icon.svg       icône de l'onglet ; apple-touch-icon.png : icône d'écran d'accueil
og.jpg         image d'aperçu des liens partagés (source : tools/og-image.html)
```

### Serveur des salles (`server/`)

Le mode « Qui écoute ça ? » se joue à plusieurs, chacun sur son téléphone, avec un code de salle. Chacun apporte 15 de ses titres ; à chaque manche, un extrait passe sur chaque téléphone (ou seulement sur celui de l'hôte, réglage « Tous dans la même pièce ») et tout le monde devine à qui il appartient et de quel titre il s'agit. Le site reste statique ; seules les salles passent par un Worker Cloudflare en TypeScript, avec un Durable Object par salle (`server/src/room.ts`). Le serveur arbitre : il tire les manches (autant de titres pour chaque joueur, entre 10 et 15 manches), garde les réponses secrètes jusqu'à la révélation, chronomètre (20 s, plus 3 s de décompte en option) et compte les points (`server/src/game.ts`).

- Une salle accueille 8 joueurs au plus ; deux pseudos identiques deviennent « Léa » et « Léa 2 ».
- L'hôte lance la partie et passe d'une manche à l'autre. Si son téléphone se déconnecte, n'importe quel joueur peut le faire à sa place : la salle n'est jamais bloquée.
- Une salle s'efface 2 heures après sa création ou après la dernière partie lancée.
- Seul le site du jeu peut ouvrir une salle (en-tête `Origin`), et une même adresse ne peut pas en créer plus de 10 par minute (`ratelimits` dans `wrangler.jsonc`).

Barème : 100 points par bonne réponse (à qui, quel titre), plus 50 au plus pour la vitesse ; −50 si l'on ne reconnaît pas son propre titre.

```bash
cd server
npm install
npm run dev     # serveur local sur http://127.0.0.1:8787
npm test        # test du salon, serveur local lancé
npm run test:game   # partie complète à trois joueurs (environ 30 s)
```

`server/dev.html` simule plusieurs téléphones dans un même onglet (à ouvrir depuis le site local). Mise en ligne : `npm run deploy`, avec un compte Cloudflare.

### Lancer en local

```bash
python -m http.server 8888
```

Puis ouvrir http://127.0.0.1:8888. Rien n'est mesuré en local.

### Mettre en ligne

Le site est servi par GitHub Pages depuis `main`. Avant chaque mise en ligne, **augmente le numéro `?v=`** des scripts en bas de `index.html`. Sinon, des navigateurs peuvent mélanger la nouvelle page et d'anciens scripts gardés en cache.

### Configuration (`config.js`)

- `SPOTIFY_CLIENT_ID` : l'app créée sur developer.spotify.com. Son Redirect URI doit être l'adresse exacte du site.
- `STATS.umamiId` ou `STATS.goatcounter` : le compte de mesure d'audience. Vide, rien n'est envoyé.
- `ROOMS_URL` : l'adresse du serveur des salles une fois déployé. Vide, la tuile « Qui écoute ça ? » est cachée en ligne (en local, le serveur de développement est utilisé).

Événements mesurés :

- accueil et sources : `source-ouverte`, `deezer-connecte`, `historique-importe`, `spotify-connexion`, `spotify-refuse`, `spotify-bloque`, `erreur-source`, `lien-auteur` ;
- blindtest : `partie-lancee`, `partie-finie`, `partie-abandonnee`, `partage`, `defi-ouvert` ;
- Pochette surprise : `pochette-lancee`, `pochette-finie`, `pochette-partage`, `pochette-defi-ouvert` ;
- Feat sur feat : `feat-lancee`, `feat-finie`, `feat-partage`, `feat-defi-ouvert` ;
- salles : `salle-creee`, `salle-rejointe`, `salle-musique`, `salle-retirage`, `salle-lancee`, `salle-finie`.
