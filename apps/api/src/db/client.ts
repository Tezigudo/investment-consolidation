import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

runMigrations(db);
