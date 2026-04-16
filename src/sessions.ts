import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id           TEXT PRIMARY KEY,
        session_id        TEXT,
        repo              TEXT,
        daily_cost_usd    REAL NOT NULL DEFAULT 0,
        daily_cost_date   TEXT NOT NULL DEFAULT '',
        last_turn_at      INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  getSessionId(chatId: string): string | null {
    const row = this.db
      .prepare<[string], { session_id: string | null }>(
        `SELECT session_id FROM chats WHERE chat_id = ?`,
      )
      .get(chatId);
    return row?.session_id ?? null;
  }

  saveSessionId(chatId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, session_id, last_turn_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_turn_at = excluded.last_turn_at`,
      )
      .run(chatId, sessionId, Date.now());
  }

  clearSession(chatId: string): void {
    this.db
      .prepare(`UPDATE chats SET session_id = NULL WHERE chat_id = ?`)
      .run(chatId);
  }

  getRepo(chatId: string): string | null {
    const row = this.db
      .prepare<[string], { repo: string | null }>(
        `SELECT repo FROM chats WHERE chat_id = ?`,
      )
      .get(chatId);
    return row?.repo ?? null;
  }

  setRepo(chatId: string, repo: string): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, repo) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET repo = excluded.repo`,
      )
      .run(chatId, repo);
  }

  getDailyCost(chatId: string): number {
    const row = this.db
      .prepare<[string], { daily_cost_usd: number; daily_cost_date: string }>(
        `SELECT daily_cost_usd, daily_cost_date FROM chats WHERE chat_id = ?`,
      )
      .get(chatId);
    if (!row) return 0;
    return row.daily_cost_date === utcDate() ? row.daily_cost_usd : 0;
  }

  addCost(chatId: string, usd: number): number {
    const today = utcDate();
    const current = this.getDailyCost(chatId);
    const next = current + usd;
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, daily_cost_usd, daily_cost_date)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           daily_cost_usd = ?,
           daily_cost_date = ?`,
      )
      .run(chatId, next, today, next, today);
    return next;
  }

  close(): void {
    this.db.close();
  }
}
