#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL manquant. Veuillez définir la variable d\'environnement.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function parseArgs(argv) {
  const updates = [];
  let filePath;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      filePath = argv[i + 1];
      i += 1;
      continue;
    }

    const [email, password] = arg.split('=');
    if (!email || !password) {
      console.error(`Argument invalide "${arg}". Utilisez le format email=nouveauMotDePasse.`);
      process.exit(1);
    }
    updates.push({ email, password });
  }

  if (filePath) {
    const absolutePath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`Fichier introuvable : ${absolutePath}`);
      process.exit(1);
    }

    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    try {
      const parsed = JSON.parse(fileContent);
      if (!Array.isArray(parsed)) {
        throw new Error('Le fichier JSON doit contenir un tableau d\'objets { "email", "password" }');
      }
      for (const entry of parsed) {
        if (!entry.email || !entry.password) {
          throw new Error('Chaque objet doit contenir "email" et "password".');
        }
        updates.push({ email: entry.email, password: entry.password });
      }
    } catch (error) {
      console.error(`Erreur de parsing du fichier JSON : ${error.message}`);
      process.exit(1);
    }
  }

  return updates;
}

async function main() {
  const updates = parseArgs(process.argv.slice(2));

  if (updates.length === 0) {
    console.error('Aucun mot de passe à réinitialiser. Fournissez des couples email=motdepasse ou un fichier via --file.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    for (const { email, password } of updates) {
      const hashed = await bcrypt.hash(password, 10);
      const result = await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2)',
        [hashed, email],
      );

      if (result.rowCount === 0) {
        console.warn(`⚠️  Aucun compte trouvé pour ${email}`);
      } else {
        console.log(`✅ Mot de passe réinitialisé pour ${email}`);
      }
    }
  } catch (error) {
    console.error('❌ Erreur lors de la réinitialisation :', error.message || error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Erreur inattendue :', error.message || error);
  process.exit(1);
});
