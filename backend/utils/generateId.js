// Generates a unique "friend ID" — a 1-9 digit number nobody else has.
// We generate 6-digit numbers by default (enough for a million users
// before collisions get common) and retry on the rare clash. The
// database's UNIQUE constraint on friend_id is the real safety net —
// this loop just avoids wasting round trips on obvious collisions.

const pool = require('../db');

function randomDigits(length) {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += Math.floor(Math.random() * 10);
  }
  // avoid a leading zero eating into the digit count visually, but it's fine either way
  return str;
}

async function generateUniqueFriendId(length = 6) {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = randomDigits(length);
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE friend_id = $1',
      [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  // Extremely unlikely to hit this, but if we do, grow the digit count.
  if (length < 9) return generateUniqueFriendId(length + 1);
  throw new Error('Could not generate a unique ID — ID space exhausted.');
}

module.exports = { generateUniqueFriendId };
