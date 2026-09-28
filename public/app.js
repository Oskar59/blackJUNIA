(() => {
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    auth: $('#screen-auth'),
    lobby: $('#screen-lobby'),
    table: $('#screen-table'),
  };

  let me = null;       // { username, chips, ... }
  let socket = null;
  let tableState = null;
  let betDefaultSetForRound = null; // évite d'écraser la saisie du joueur à chaque state
  let previousStatuses = {};        // username -> statut précédent, pour détecter les transitions
  let previousHandLengths = { dealer: 0, players: {} }; // pour n'animer que les cartes nouvellement distribuées
  let sawFirstState = false;        // évite d'animer tout dès le premier état reçu (reload / reconnexion)

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erreur.');
    return data;
  }

  // ---------- Auth ----------
  $('#screen-auth .tab').parentElement.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $('#form-login').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('#form-register').classList.toggle('hidden', btn.dataset.tab !== 'register');
  });

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/api/login', { username: fd.get('username'), password: fd.get('password') });
      onAuthenticated(user);
    } catch (err) { toast(err.message); }
  });

  $('#form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/api/register', { username: fd.get('username'), password: fd.get('password') });
      onAuthenticated(user);
    } catch (err) { toast(err.message); }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/logout');
    me = null;
    if (socket) { socket.disconnect(); socket = null; }
    showScreen('auth');
  });

  function onAuthenticated(user) {
    me = user;
    connectSocket();
    enterLobby();
  }

  function connectSocket() {
    if (socket) return;
    socket = io();
    socket.on('table:joined', ({ code }) => {
      $('#table-code-label').textContent = code;
      betDefaultSetForRound = null;
      previousStatuses = {};
      previousHandLengths = { dealer: 0, players: {} };
      sawFirstState = false;
      showScreen('table');
    });
    socket.on('table:state', (state) => {
      tableState = state;
      renderTable();
    });
    socket.on('error', ({ message }) => toast(message));
    socket.on('connect_error', () => toast('Connexion temps réel indisponible.'));
  }

  // ---------- Lobby ----------
  function enterLobby() {
    $('#lobby-username').textContent = me.username;
    renderLobbyChips();
    showScreen('lobby');
    loadLeaderboard();
  }

  function renderLobbyChips() {
    $('#lobby-chips').innerHTML = `<b>${me.chips}</b> jetons`;
    $('#btn-lobby-rebuy').classList.toggle('hidden', me.chips > 0);
  }

  $('#btn-lobby-rebuy').addEventListener('click', async () => {
    try {
      const { user } = await api('/api/rebuy');
      me = user;
      renderLobbyChips();
    } catch (err) { toast(err.message); }
  });

  async function fetchMe() {
    const res = await fetch('/api/me');
    return res.json();
  }

  async function loadLeaderboard() {
    const res = await fetch('/api/leaderboard');
    const { leaderboard } = await res.json();
    const body = $('#leaderboard-body');
    body.innerHTML = leaderboard.map((u, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${u.chips}</td>
        <td>${u.gamesPlayed}</td>
        <td>${u.wins}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="color:var(--muted)">Aucune partie jouée pour l’instant.</td></tr>';
  }
  $('#btn-refresh-leaderboard').addEventListener('click', loadLeaderboard);

  $('#btn-create-table').addEventListener('click', () => socket.emit('table:create'));
  $('#btn-join-table').addEventListener('click', () => {
    const code = $('#join-code').value.trim();
    if (!code) return toast('Entrez un code de table.');
    socket.emit('table:join', { code });
  });

  $('#btn-leave-table').addEventListener('click', () => {
    socket.emit('table:leave');
    tableState = null;
    betDefaultSetForRound = null;
    previousStatuses = {};
    previousHandLengths = { dealer: 0, players: {} };
    sawFirstState = false;
    showScreen('lobby');
    fetchMe().then(({ user }) => { if (user) { me = user; renderLobbyChips(); } });
    loadLeaderboard();
  });

  $('#btn-copy-code').addEventListener('click', async () => {
    if (!tableState) return;
    try {
      await navigator.clipboard.writeText(tableState.code);
      toast('Code copié !');
    } catch {
      toast(`Code de table : ${tableState.code}`);
    }
  });

  // ---------- Table de jeu ----------
  $('#btn-start-round').addEventListener('click', () => socket.emit('round:start'));
  $('#btn-place-bet').addEventListener('click', () => {
    const amount = parseInt($('#bet-amount').value, 10);
    socket.emit('bet:place', { amount });
  });
  $('#btn-hit').addEventListener('click', () => socket.emit('action:hit'));
  $('#btn-stand').addEventListener('click', () => socket.emit('action:stand'));
  $('#btn-double').addEventListener('click', () => socket.emit('action:double'));
  $('#btn-rebuy').addEventListener('click', async () => {
    try {
      const { user } = await api('/api/rebuy');
      me = user;
      if (tableState) {
        const mine = tableState.players.find((p) => p.username === me.username);
        if (mine) mine.chips = me.chips;
        renderTable();
      }
    } catch (err) { toast(err.message); }
  });

  function cardHtml(card, animate = false, delayIndex = 0) {
    const anim = animate ? ` card-deal" style="animation-delay:${Math.max(0, delayIndex) * 0.18}s` : '';
    if (!card) return `<div class="card hidden-card"></div>`;
    const red = card.s === '♥' || card.s === '♦';
    return `<div class="card ${red ? 'red' : ''}${anim}">${card.r}<span style="font-size:12px">${card.s}</span></div>`;
  }

  function statusLabel(status) {
    return {
      idle: 'En attente', betting: 'Doit miser', ready: 'Mise placée', playing: 'Joue…',
      stood: 'Reste', bust: 'Dépassé (21+)', blackjack: 'Blackjack !', done: 'Terminé',
    }[status] || status;
  }

  function renderTable() {
    if (!tableState) return;
    $('#table-code-label').textContent = tableState.code;

    const isFirstRender = !sawFirstState;

    const dHand = tableState.dealer.hand;
    const dPrev = isFirstRender ? dHand.length : previousHandLengths.dealer;
    $('#dealer-hand').innerHTML = dHand.map((c, i) => cardHtml(c, !isFirstRender && i >= dPrev, i - dPrev)).join('') +
      (tableState.dealer.hidden ? cardHtml(null) : '');
    previousHandLengths.dealer = dHand.length;
    $('#dealer-total').textContent = tableState.dealer.hidden ? '' : `Total : ${tableState.dealer.total}`;

    detectBlackjacks(isFirstRender);

    $('#seats').innerHTML = tableState.players.map((p) => {
      const pPrev = isFirstRender ? p.hand.length : (previousHandLengths.players[p.username] || 0);
      const handHtml = p.hand.map((c, i) => cardHtml(c, !isFirstRender && i >= pPrev, i - pPrev)).join('');
      previousHandLengths.players[p.username] = p.hand.length;
      const isMe = p.username === me.username;
      const isTurn = tableState.phase === 'playing' && p.seat === tableState.turnIndex;
      let badgeClass = '';
      let badgeText = statusLabel(p.status);
      if (p.status === 'done') {
        // on ne connaît pas l'issue précise ici sans la rejouer ; on affiche juste le total
        badgeText = `Total ${p.total}`;
      }
      if (p.status === 'blackjack') badgeClass = 'win';
      if (p.status === 'bust') badgeClass = 'lose';
      return `
        <div class="seat ${isTurn ? 'turn' : ''} ${p.connected ? '' : 'disconnected'}">
          <div class="name">${escapeHtml(p.username)} ${isMe ? '<span class="you">(vous)</span>' : ''}</div>
          <div class="chips">${p.chips} jetons ${p.bet ? `· mise ${p.bet}` : ''}</div>
          <div class="hand">${handHtml}</div>
          ${p.hand.length ? `<div class="total">${p.total}</div>` : ''}
          <span class="status-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('');

    $('#table-log').innerHTML = tableState.log.map(escapeHtml).join('<br>');

    updateControls();
    sawFirstState = true;
  }

  function updateControls() {
    const rows = ['idle', 'bet', 'play', 'waiting', 'rebuy'];
    rows.forEach((r) => $(`#controls-${r}`).classList.add('hidden'));

    const myPlayer = tableState.players.find((p) => p.username === me.username);
    if (!myPlayer) return;

    if (myPlayer.chips <= 0) {
      $('#controls-rebuy').classList.remove('hidden');
      return;
    }

    if (tableState.phase === 'lobby' || tableState.phase === 'results') {
      $('#controls-idle').classList.remove('hidden');
      return;
    }

    if (tableState.phase === 'betting') {
      if (myPlayer.status === 'betting') {
        $('#controls-bet').classList.remove('hidden');
        $('#bet-amount').min = tableState.minBet;
        // ne fixe la valeur par défaut qu'une seule fois par manche, sinon la saisie
        // en cours d'un joueur est écrasée à chaque fois qu'un autre joueur mise.
        if (betDefaultSetForRound !== tableState.round) {
          $('#bet-amount').value = tableState.minBet;
          betDefaultSetForRound = tableState.round;
        }
      } else {
        $('#controls-waiting').classList.remove('hidden');
        $('#waiting-text').textContent = 'En attente des autres joueurs…';
      }
      return;
    }

    if (tableState.phase === 'playing') {
      if (myPlayer.seat === tableState.turnIndex && myPlayer.status === 'playing') {
        $('#controls-play').classList.remove('hidden');
      } else {
        $('#controls-waiting').classList.remove('hidden');
        const turnPlayer = tableState.players.find((p) => p.seat === tableState.turnIndex);
        $('#waiting-text').textContent = turnPlayer ? `Tour de ${turnPlayer.username}…` : 'Le croupier joue…';
      }
      return;
    }

    if (tableState.phase === 'dealer') {
      $('#controls-waiting').classList.remove('hidden');
      $('#waiting-text').textContent = 'Le croupier joue…';
    }
  }

  // Détecte les transitions vers le statut "blackjack" pour déclencher l'animation,
  // sans la redéclencher à chaque state broadcast ni au premier chargement (reload en résultats).
  function detectBlackjacks(isFirstRender) {
    if (isFirstRender) {
      tableState.players.forEach((p) => (previousStatuses[p.username] = p.status));
      return;
    }
    tableState.players.forEach((p) => {
      const prev = previousStatuses[p.username];
      if (p.status === 'blackjack' && prev !== 'blackjack') {
        playBlackjackAnimation(p.username === me.username ? 'VOUS' : p.username);
      }
      previousStatuses[p.username] = p.status;
    });
  }

  function playBlackjackAnimation(label) {
    const overlay = document.createElement('div');
    overlay.className = 'bj-overlay';
    overlay.innerHTML = `
      <div class="bj-text">🔥 BLACKJACK 🔥</div>
      <div class="bj-sub">${escapeHtml(label)}</div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1800);
    playBlackjackSound();
  }

  // Petit jingle synthétisé (pas de fichier audio externe, donc pas de souci de droits) :
  // un enchaînement rapide de notes montantes façon "victoire".
  function playBlackjackSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const notes = [523.25, 659.25, 783.99, 1046.5]; // do-mi-sol-do
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        const start = ctx.currentTime + i * 0.09;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.18);
      });
      setTimeout(() => ctx.close(), 900);
    } catch {
      // certains navigateurs bloquent l'audio sans interaction préalable : on ignore silencieusement
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Démarrage ----------
  (async function init() {
    const { user } = await fetchMe();
    if (user) onAuthenticated(user);
  })();
})();
