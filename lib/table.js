const { createShoe, handValue, isBlackjack, isBust } = require('./blackjack');

const MAX_PLAYERS = 10;
const MIN_BET = 10;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I/O/0/1 ambigus

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

class Table {
  constructor(code, hostUsername) {
    this.code = code;
    this.hostUsername = hostUsername;
    this.players = []; // { username, seat, hand, bet, status, connected, chips }
    this.dealer = { hand: [], hidden: true };
    this.shoe = [];
    this.phase = 'lobby'; // lobby | betting | playing | dealer | results
    this.turnIndex = -1;
    this.minBet = MIN_BET;
    this.round = 0;
    this.log = [];
  }

  pushLog(msg) {
    this.log.push(msg);
    if (this.log.length > 30) this.log.shift();
  }

  findPlayer(username) {
    return this.players.find((p) => p.username === username);
  }

  addPlayer(username, chips) {
    const existing = this.findPlayer(username);
    if (existing) {
      existing.connected = true;
      existing.chips = chips;
      return { ok: true, reconnected: true };
    }
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: 'Table complète (10 joueurs max).' };
    const seat = this.players.length;
    this.players.push({
      username,
      seat,
      chips,
      hand: [],
      bet: 0,
      status: 'idle', // idle | betting | playing | stood | bust | blackjack | done
      connected: true,
    });
    this.pushLog(`${username} a rejoint la table.`);
    return { ok: true, reconnected: false };
  }

  setConnected(username, connected) {
    const p = this.findPlayer(username);
    if (p) p.connected = connected;
  }

  removePlayer(username) {
    this.players = this.players.filter((p) => p.username !== username);
    this.players.forEach((p, i) => (p.seat = i));
    this.pushLog(`${username} a quitté la table.`);
  }

  activePlayers() {
    return this.players.filter((p) => p.connected);
  }

  canStartBetting() {
    return (this.phase === 'lobby' || this.phase === 'results') && this.activePlayers().some((p) => p.chips > 0);
  }

  startBettingRound() {
    if (!this.canStartBetting()) return { ok: false, error: "Impossible de démarrer maintenant." };
    this.round += 1;
    this.dealer = { hand: [], hidden: true };
    this.turnIndex = -1;
    this.phase = 'betting';
    for (const p of this.players) {
      p.hand = [];
      p.bet = 0;
      p.status = p.connected && p.chips > 0 ? 'betting' : 'idle';
    }
    this.pushLog(`— Manche ${this.round} : les mises sont ouvertes —`);
    return { ok: true };
  }

  placeBet(username, amount) {
    if (this.phase !== 'betting') return { ok: false, error: "Ce n'est pas la phase de mise." };
    const p = this.findPlayer(username);
    if (!p || p.status !== 'betting') return { ok: false, error: 'Vous ne pouvez pas miser.' };
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < this.minBet) return { ok: false, error: `Mise minimum : ${this.minBet}.` };
    if (amount > p.chips) return { ok: false, error: 'Solde de jetons insuffisant.' };
    p.bet = amount;
    p.status = 'ready';
    this.pushLog(`${username} mise ${amount} jetons.`);
    return { ok: true };
  }

  readyToDeal() {
    const bettors = this.players.filter((p) => p.connected && (p.status === 'betting' || p.status === 'ready'));
    return bettors.length > 0 && bettors.every((p) => p.status === 'ready');
  }

  deal() {
    if (this.phase !== 'betting') return { ok: false, error: "Ce n'est pas la phase de mise." };
    const bettors = this.players.filter((p) => p.status === 'ready');
    if (bettors.length === 0) return { ok: false, error: 'Personne n’a misé.' };
    // reconstitue un sabot frais à chaque manche : simple et sans fuite d'information
    this.shoe = createShoe(4);
    for (const p of bettors) p.hand = [];
    this.dealer.hand = [];
    this.dealer.hidden = true;

    for (let round = 0; round < 2; round++) {
      for (const p of bettors) p.hand.push(this.shoe.pop());
      this.dealer.hand.push(this.shoe.pop());
    }

    for (const p of this.players) {
      if (p.status !== 'ready') continue;
      if (isBlackjack(p.hand)) {
        p.status = 'blackjack';
      } else {
        p.status = 'playing';
      }
    }

    this.phase = 'playing';
    this.pushLog('Cartes distribuées.');
    this.turnIndex = -1;
    this.advanceTurn();
    return { ok: true };
  }

  advanceTurn() {
    const candidates = this.players.filter((p) => p.status === 'playing').sort((a, b) => a.seat - b.seat);
    const next = candidates.find((p) => p.seat > this.turnIndex);
    const chosen = next || candidates[0];
    if (!chosen) {
      this.turnIndex = -1;
      this.playDealer();
      return;
    }
    this.turnIndex = chosen.seat;
  }

  hit(username) {
    if (this.phase !== 'playing') return { ok: false, error: "Ce n'est pas votre tour." };
    const p = this.findPlayer(username);
    if (!p || p.status !== 'playing' || p.seat !== this.turnIndex) return { ok: false, error: "Ce n'est pas votre tour." };
    p.hand.push(this.shoe.pop());
    this.pushLog(`${username} tire une carte.`);
    if (isBust(p.hand)) {
      p.status = 'bust';
      this.pushLog(`${username} dépasse 21 et perd la main.`);
      this.advanceTurn();
    } else if (handValue(p.hand) === 21) {
      p.status = 'stood';
      this.advanceTurn();
    }
    return { ok: true };
  }

  stand(username) {
    if (this.phase !== 'playing') return { ok: false, error: "Ce n'est pas votre tour." };
    const p = this.findPlayer(username);
    if (!p || p.status !== 'playing' || p.seat !== this.turnIndex) return { ok: false, error: "Ce n'est pas votre tour." };
    p.status = 'stood';
    this.pushLog(`${username} reste.`);
    this.advanceTurn();
    return { ok: true };
  }

  double(username) {
    if (this.phase !== 'playing') return { ok: false, error: "Ce n'est pas votre tour." };
    const p = this.findPlayer(username);
    if (!p || p.status !== 'playing' || p.seat !== this.turnIndex) return { ok: false, error: "Ce n'est pas votre tour." };
    if (p.hand.length !== 2) return { ok: false, error: 'Doublage possible seulement sur les 2 premières cartes.' };
    if (p.bet > p.chips) return { ok: false, error: 'Jetons insuffisants pour doubler.' };
    p.bet *= 2;
    p.hand.push(this.shoe.pop());
    this.pushLog(`${username} double sa mise à ${p.bet}.`);
    if (isBust(p.hand)) {
      p.status = 'bust';
      this.pushLog(`${username} dépasse 21 et perd la main.`);
    } else {
      p.status = 'stood';
    }
    this.advanceTurn();
    return { ok: true };
  }

  playDealer() {
    this.phase = 'dealer';
    this.dealer.hidden = false;
    const anyoneLeft = this.players.some((p) => p.status === 'blackjack' || p.status === 'stood');
    if (anyoneLeft) {
      while (handValue(this.dealer.hand) < 17) {
        this.dealer.hand.push(this.shoe.pop());
      }
    }
    this.pushLog(`Le croupier révèle ${handValue(this.dealer.hand)}.`);
    return this.settle();
  }

  settle() {
    this.phase = 'results';
    const dealerTotal = handValue(this.dealer.hand);
    const dealerBJ = isBlackjack(this.dealer.hand);
    const dealerBusted = dealerTotal > 21;
    const results = [];

    for (const p of this.players) {
      if (!['blackjack', 'stood', 'bust'].includes(p.status)) continue;
      let outcome;
      let chipsDelta;
      if (p.status === 'bust') {
        outcome = 'bust';
        chipsDelta = -p.bet;
      } else if (p.status === 'blackjack') {
        if (dealerBJ) {
          outcome = 'push';
          chipsDelta = 0;
        } else {
          outcome = 'blackjack';
          chipsDelta = Math.floor(p.bet * 1.5);
        }
      } else if (dealerBusted) {
        outcome = 'win';
        chipsDelta = p.bet;
      } else {
        const playerTotal = handValue(p.hand);
        if (playerTotal > dealerTotal) {
          outcome = 'win';
          chipsDelta = p.bet;
        } else if (playerTotal < dealerTotal) {
          outcome = 'loss';
          chipsDelta = -p.bet;
        } else {
          outcome = 'push';
          chipsDelta = 0;
        }
      }
      p.chips += chipsDelta;
      p.status = 'done';
      results.push({ username: p.username, outcome, chipsDelta, bet: p.bet });
    }
    this.pushLog('Manche terminée.');
    this.lastResults = results;
    return { ok: true, results };
  }

  publicState() {
    return {
      code: this.code,
      hostUsername: this.hostUsername,
      phase: this.phase,
      round: this.round,
      minBet: this.minBet,
      turnIndex: this.turnIndex,
      dealer: {
        hand: this.dealer.hidden ? [this.dealer.hand[0]].filter(Boolean) : this.dealer.hand,
        hidden: this.dealer.hidden,
        total: this.dealer.hidden ? null : handValue(this.dealer.hand),
      },
      players: this.players.map((p) => ({
        username: p.username,
        seat: p.seat,
        chips: p.chips,
        hand: p.hand,
        bet: p.bet,
        status: p.status,
        connected: p.connected,
        total: p.hand.length ? handValue(p.hand) : 0,
      })),
      log: this.log.slice(-10),
    };
  }
}

class TableManager {
  constructor() {
    this.tables = new Map();
  }

  createTable(hostUsername, chips) {
    let code;
    do {
      code = randomCode();
    } while (this.tables.has(code));
    const table = new Table(code, hostUsername);
    table.addPlayer(hostUsername, chips);
    this.tables.set(code, table);
    return table;
  }

  getTable(code) {
    return this.tables.get(String(code).toUpperCase());
  }

  joinTable(code, username, chips) {
    const table = this.getTable(code);
    if (!table) return { ok: false, error: 'Code de table introuvable.' };
    const res = table.addPlayer(username, chips);
    if (!res.ok) return res;
    return { ok: true, table };
  }

  cleanupIfEmpty(code) {
    const table = this.tables.get(code);
    if (table && table.players.every((p) => !p.connected)) {
      this.tables.delete(code);
    }
  }
}

module.exports = { Table, TableManager, MAX_PLAYERS, MIN_BET };
