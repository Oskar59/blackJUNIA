const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createServer } = require('http');
const { Server } = require('socket.io');

const store = require('./lib/store');
const { TableManager } = require('./lib/table');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-deploying';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 jours
    sameSite: 'lax',
  },
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// Le serveur socket.io partage la même session que les routes HTTP,
// ce qui permet d'identifier le joueur sur chaque connexion temps réel.
io.engine.use(sessionMiddleware);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Non connecté.' });
  next();
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: "Pseudo invalide (3 à 20 caractères, lettres/chiffres/_ )." });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum.' });
  }
  if (store.usernameTaken(username)) {
    return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = store.createUser(username, hash);
  req.session.username = user.username;
  res.json({ user: store.publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = store.getUser(username || '');
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects.' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects.' });
  req.session.username = user.username;
  res.json({ user: store.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.username) return res.json({ user: null });
  const user = store.getUser(req.session.username);
  res.json({ user: store.publicUser(user) });
});

// Renfloue un compte tombé à zéro jeton (simplification volontaire pour un jeu entre amis).
app.post('/api/rebuy', requireAuth, (req, res) => {
  const user = store.getUser(req.session.username);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (user.chips > 0) return res.status(400).json({ error: 'Vous avez encore des jetons.' });
  const updated = store.updateUser(user.username, { chips: 500 });
  res.json({ user: store.publicUser(updated) });
});

app.get('/api/leaderboard', (req, res) => {
  const users = store.allUsers()
    .map(store.publicUser)
    .sort((a, b) => b.chips - a.chips)
    .slice(0, 50);
  res.json({ leaderboard: users });
});

// ---- Temps réel : tables de blackjack ----

const manager = new TableManager();
const socketUser = new Map(); // socket.id -> { username, code }

function broadcastTable(table) {
  io.to(`table:${table.code}`).emit('table:state', table.publicState());
}

function currentChips(username) {
  const u = store.getUser(username);
  return u ? u.chips : 0;
}

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;
  if (!username || !store.getUser(username)) {
    socket.emit('error', { message: 'Session expirée, reconnectez-vous.' });
    socket.disconnect(true);
    return;
  }

  socket.on('table:create', () => {
    const table = manager.createTable(username, currentChips(username));
    socketUser.set(socket.id, { username, code: table.code });
    socket.join(`table:${table.code}`);
    socket.emit('table:joined', { code: table.code });
    broadcastTable(table);
  });

  socket.on('table:join', ({ code } = {}) => {
    const res = manager.joinTable(code, username, currentChips(username));
    if (!res.ok) return socket.emit('error', { message: res.error });
    socketUser.set(socket.id, { username, code: res.table.code });
    socket.join(`table:${res.table.code}`);
    socket.emit('table:joined', { code: res.table.code });
    broadcastTable(res.table);
  });

  socket.on('table:leave', () => {
    const info = socketUser.get(socket.id);
    if (!info) return;
    const table = manager.getTable(info.code);
    if (table) {
      table.removePlayer(username);
      socket.leave(`table:${info.code}`);
      broadcastTable(table);
      manager.cleanupIfEmpty(info.code);
    }
    socketUser.delete(socket.id);
  });

  socket.on('round:start', () => {
    const table = tableFor(socket);
    if (!table) return;
    const res = table.startBettingRound();
    if (!res.ok) return socket.emit('error', { message: res.error });
    broadcastTable(table);
  });

  socket.on('bet:place', ({ amount } = {}) => {
    const table = tableFor(socket);
    if (!table) return;
    const res = table.placeBet(username, amount);
    if (!res.ok) return socket.emit('error', { message: res.error });
    broadcastTable(table);
    if (table.readyToDeal()) {
      const dealRes = table.deal();
      if (dealRes.ok) broadcastTable(table);
    }
  });

  socket.on('action:hit', () => runAction(socket, (t) => t.hit(username)));
  socket.on('action:stand', () => runAction(socket, (t) => t.stand(username)));
  socket.on('action:double', () => runAction(socket, (t) => t.double(username)));

  socket.on('disconnect', () => {
    const info = socketUser.get(socket.id);
    if (!info) return;
    const table = manager.getTable(info.code);
    if (table) {
      table.setConnected(username, false);
      broadcastTable(table);
      manager.cleanupIfEmpty(info.code);
    }
    socketUser.delete(socket.id);
  });

  function tableFor(sock) {
    const info = socketUser.get(sock.id);
    if (!info) {
      sock.emit('error', { message: "Vous n'êtes pas installé à une table." });
      return null;
    }
    return manager.getTable(info.code);
  }

  function runAction(sock, fn) {
    const table = tableFor(sock);
    if (!table) return;
    const res = fn(table);
    if (!res.ok) return sock.emit('error', { message: res.error });
    // dès que la manche vient d'être soldée, on persiste les jetons/statistiques en base
    if (table.phase === 'results' && Array.isArray(table.lastResults)) {
      for (const r of table.lastResults) {
        store.applyRoundResult(r.username, { chipsDelta: r.chipsDelta, outcome: r.outcome });
      }
      for (const p of table.players) {
        const u = store.getUser(p.username);
        if (u) p.chips = u.chips;
      }
      table.lastResults = null; // évite un double règlement si l'état est retransmis
    }
    broadcastTable(table);
  }
});

httpServer.listen(PORT, () => {
  console.log(`Blackjack multijoueur en écoute sur http://localhost:${PORT}`);
});
