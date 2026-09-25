// Persistence très simple basée sur un fichier JSON.
// Suffisant pour un groupe d'amis ; pas de dépendance native à compiler.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // fichier corrompu -> on repart propre plutôt que de planter le serveur
    return { users: {} };
  }
}

let cache = load();
let saveTimer = null;

function persist() {
  // écriture différée (debounce) pour éviter trop d'I/O disque pendant une partie
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  }, 200);
}

function key(username) {
  return String(username).toLowerCase();
}

function defaultStats() {
  return {
    chips: 1000,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    blackjacks: 0,
    busts: 0,
  };
}

module.exports = {
  getUser(username) {
    return cache.users[key(username)] || null;
  },
  usernameTaken(username) {
    return !!cache.users[key(username)];
  },
  createUser(username, passwordHash) {
    const user = {
      username, // conserve la casse d'origine pour l'affichage
      passwordHash,
      createdAt: Date.now(),
      ...defaultStats(),
    };
    cache.users[key(username)] = user;
    persist();
    return user;
  },
  updateUser(username, patch) {
    const u = cache.users[key(username)];
    if (!u) return null;
    Object.assign(u, patch);
    persist();
    return u;
  },
  // Applique le résultat d'une main jouée par ce joueur à ses statistiques.
  applyRoundResult(username, { chipsDelta, outcome }) {
    const u = cache.users[key(username)];
    if (!u) return null;
    u.chips = Math.max(0, u.chips + chipsDelta);
    u.gamesPlayed += 1;
    if (outcome === 'win' || outcome === 'blackjack') u.wins += 1;
    if (outcome === 'blackjack') u.blackjacks += 1;
    if (outcome === 'loss' || outcome === 'bust') u.losses += 1;
    if (outcome === 'bust') u.busts += 1;
    if (outcome === 'push') u.pushes += 1;
    persist();
    return u;
  },
  allUsers() {
    return Object.values(cache.users);
  },
  publicUser(u) {
    if (!u) return null;
    const { username, chips, gamesPlayed, wins, losses, pushes, blackjacks, busts } = u;
    return { username, chips, gamesPlayed, wins, losses, pushes, blackjacks, busts };
  },
};
