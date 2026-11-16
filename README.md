# Blindtest

**Un blindtest sur ta propre musique.** Tu choisis d'où vient ta musique, tu écoutes un extrait, tu trouves l'artiste, le titre, l'album, l'année. Ensuite tu défies tes potes sur tes goûts.

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
- **Deux façons de répondre.** *À choisir* : 4 propositions tirées de ta propre musique, et un curseur pour les années (par défaut sur téléphone). *À taper* : il faut tout écrire, les fautes de frappe sont tolérées.
- **Des questions qui dépendent de la source.** Artiste, titre, album, année de sortie, année où tu l'as liké, année où tu l'as découvert.
- **Partage et défis.** Ton résultat se partage en carrés (🟧 tout bon, 🟫 en partie, ⬛ raté). Pour les parties Spotify, le lien contient la partie complète : ton pote rejoue les mêmes titres et doit battre ton score.

## Vie privée

Tout se passe dans le navigateur. Il n'y a pas de serveur ni de compte, et ton historique ne quitte jamais ton appareil. La mesure d'audience, si elle est activée, n'utilise aucun cookie et ne reçoit que des faits de partie (source, mode, tranche de score), jamais un nom, un profil ou un titre.

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
app.js         déroulé du jeu, sources Spotify, accueil
deezer.js      API publique Deezer (JSONP), profils, lecteur d'extraits
history.js     lecture des exports Spotify et YouTube Music (ZIP ou JSON)
scoring.js     barème (textes tolérants, années, artistes multiples)
challenge.js   liens de défi (JSON compressé dans l'URL)
stats.js       mesure d'audience sans cookies (Umami ou GoatCounter)
config.js      Client ID Spotify et compte de mesure d'audience
og.jpg         image d'aperçu des liens partagés (source : tools/og-image.html)
```

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

Événements mesurés : `source-ouverte`, `deezer-connecte`, `historique-importe`, `spotify-connexion`, `spotify-refuse`, `partie-lancee`, `partie-finie`, `partage`, `defi-ouvert`, `erreur-source`, `lien-auteur`.
