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
    $('#lobby-chips').innerHTML = `<b>${me.chips}</b> jetons`;
    showScreen('lobby');
    loadLeaderboard();
  }

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
    showScreen('lobby');
    fetchMe().then(({ user }) => { if (user) { me = user; $('#lobby-chips').innerHTML = `<b>${me.chips}</b> jetons`; } });
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
      renderTable();
    } catch (err) { toast(err.message); }
  });

  function cardHtml(card) {
    if (!card) return '<div class="card hidden-card"></div>';
    const red = card.s === '♥' || card.s === '♦';
    return `<div class="card ${red ? 'red' : ''}">${card.r}<span style="font-size:12px">${card.s}</span></div>`;
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

    $('#dealer-hand').innerHTML = tableState.dealer.hand.map(cardHtml).join('') +
      (tableState.dealer.hidden ? cardHtml(null) : '');
    $('#dealer-total').textContent = tableState.dealer.hidden ? '' : `Total : ${tableState.dealer.total}`;

    $('#seats').innerHTML = tableState.players.map((p) => {
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
          <div class="hand">${p.hand.map(cardHtml).join('') || ''}</div>
          ${p.hand.length ? `<div class="total">${p.total}</div>` : ''}
          <span class="status-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('');

    $('#table-log').innerHTML = tableState.log.map(escapeHtml).join('<br>');

    updateControls();
  }

  function updateControls() {
    const rows = ['idle', 'bet', 'play', 'waiting', 'rebuy'];
    rows.forEach((r) => $(`#controls-${r}`).classList.add('hidden'));

    const myPlayer = tableState.players.find((p) => p.username === me.username);
    if (!myPlayer) return;

    if (myPlayer.chips <= 0 && (tableState.phase === 'lobby' || tableState.phase === 'results')) {
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
        $('#bet-amount').value = tableState.minBet;
        $('#bet-amount').min = tableState.minBet;
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Démarrage ----------
  (async function init() {
    const { user } = await fetchMe();
    if (user) onAuthenticated(user);
  })();
})();
