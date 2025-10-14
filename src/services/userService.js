const pool = require('./db');

async function getUserByEmail(email) {
  if (!email) return null;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getUserById(id) {
  if (!id) return null;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

module.exports = {
  getUserByEmail,
  getUserById,
};
