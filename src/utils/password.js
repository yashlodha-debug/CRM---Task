/**
 * Password hashing helpers. We NEVER store plain-text passwords —
 * only the bcrypt hash. bcrypt is a one-way function: given the hash,
 * there is no way to recover the original password.
 */
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function comparePassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

module.exports = { hashPassword, comparePassword };
