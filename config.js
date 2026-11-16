// Client ID de ton app Spotify (public, ce n'est pas un secret). Vide = chacun colle le sien.
const SPOTIFY_CLIENT_ID = 'f846e1a28dc54dc7a54e04d857f5b3b7';

// Mesure d'audience sans cookies. Renseigner UN des deux ; vide = rien n'est mesuré.
// - umamiId : l'identifiant du site sur cloud.umami.is (Settings → Websites → Website ID)
// - goatcounter : le code choisi sur goatcounter.com (le « monsite » de monsite.goatcounter.com)
// Rien n'est jamais envoyé depuis localhost.
const STATS = {
  umamiId: '',
  goatcounter: '',
};

// Adresse du serveur des salles « Qui écoute ça ? » (dossier server/, après `npm run deploy`),
// par exemple 'https://blindtest-salles.monnom.workers.dev'. Vide = le mode est caché en ligne ;
// en local, le serveur de développement (http://127.0.0.1:8787) est utilisé.
const ROOMS_URL = 'https://blindtest-salles.matthias-germain.workers.dev';
