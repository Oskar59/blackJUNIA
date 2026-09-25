const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createShoe(numDecks = 4) {
  const cards = [];
  for (let d = 0; d < numDecks; d++) {
    for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return parseInt(rank, 10);
}

function handValue(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c.r), 0);
  let aces = hand.filter((c) => c.r === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isSoft(hand) {
  // main contenant un As encore compté comme 11
  const raw = hand.reduce((s, c) => s + cardValue(c.r), 0);
  const aces = hand.filter((c) => c.r === 'A').length;
  return aces > 0 && raw <= 21;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

function isBust(hand) {
  return handValue(hand) > 21;
}

module.exports = { createShoe, cardValue, handValue, isSoft, isBlackjack, isBust };
