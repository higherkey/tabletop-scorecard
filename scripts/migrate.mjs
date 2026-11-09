// Applies db/migrations/*.sql not yet recorded in schema_migrations.
// Needs DATABASE_URL (owner connection string) in the environment only.
import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client, neonConfig } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('Node 22+ (global WebSocket) is required.');
  process.exit(1);
}
neonConfig.webSocketConstructor = WebSocket;

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let applied = 0;
try {
  await client.query(
    'create table if not exists public.schema_migrations (version text primary key, applied_at timestamptz default now())'
  );
  const done = new Set((await client.query('select version from public.schema_migrations')).rows.map((r) => r.version));
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) {
      console.log(`skip    ${version}`);
      continue;
    }
    const sql = await readFile(path.join(dir, file), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (version) values ($1)', [version]);
      await client.query('commit');
      console.log(`applied ${version}`);
      applied++;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      console.error(`FAILED  ${version}: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}

if (applied > 0 && !process.exitCode) {
  const project = process.env.NEON_PROJECT_ID;
  if (project) {
    const branch = process.env.NEON_BRANCH_ID ? ` --branch ${process.env.NEON_BRANCH_ID}` : '';
    const db = process.env.NEON_DATABASE ? ` --database ${process.env.NEON_DATABASE}` : '';
    execSync(`npx -y neonctl@latest data-api refresh-schema --project-id ${project}${branch}${db}`, { stdio: 'inherit' });
  } else {
    console.log('Next: npx -y neonctl@latest data-api refresh-schema --project-id <id> --branch <branch> --database neondb');
  }
}
