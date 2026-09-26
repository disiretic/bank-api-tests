// db.js — SQLite база с тестовыми данными для GraphQL банковского сервера
// Используем встроенный в Node.js модуль node:sqlite (не требует компиляции
// нативного кода — в отличие от better-sqlite3). Доступен без флагов с Node.js 22.13/23.4+.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'bank.db'));

db.exec(`
  DROP TABLE IF EXISTS transactions;
  DROP TABLE IF EXISTS cards;
  DROP TABLE IF EXISTS accounts;
  DROP TABLE IF EXISTS users;

  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,   -- намеренно plain-text: практика для отчёта об уязвимости
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    number TEXT NOT NULL,
    balance REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    number TEXT NOT NULL,
    cvv TEXT NOT NULL,
    expiry TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    type TEXT NOT NULL,          -- deposit | withdrawal | transfer
    amount REAL NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
`);

const insertUser = db.prepare('INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)');
const insertAccount = db.prepare('INSERT INTO accounts (user_id, number, balance, currency) VALUES (?, ?, ?, ?)');
const insertCard = db.prepare('INSERT INTO cards (account_id, number, cvv, expiry) VALUES (?, ?, ?, ?)');
const insertTx = db.prepare('INSERT INTO transactions (account_id, type, amount, description, created_at) VALUES (?, ?, ?, ?, ?)');

function seed() {
  db.exec('BEGIN');
  const u1 = insertUser.run('ivan_petrov', 'Passw0rd!', 'Иван Петров', 'user').lastInsertRowid;
  const u2 = insertUser.run('anna_smirnova', 'QwertY123', 'Анна Смирнова', 'user').lastInsertRowid;
  const u3 = insertUser.run('admin', 'admin123', 'Администратор', 'admin').lastInsertRowid;

  const a1 = insertAccount.run(u1, '40817810000000000123', 154320.50, 'RUB').lastInsertRowid;
  const a2 = insertAccount.run(u1, '40817810000000000456', 2000.00, 'USD').lastInsertRowid;
  const a3 = insertAccount.run(u2, '40817810000000000789', 87500.00, 'RUB').lastInsertRowid;
  const a4 = insertAccount.run(u3, '40817810000000000999', 999999.99, 'RUB').lastInsertRowid;

  insertCard.run(a1, '4276 **** **** 0123', '123', '12/27');
  insertCard.run(a3, '5536 **** **** 0789', '456', '09/26');

  const txs = [
    [a1, 'deposit', 50000, 'Зарплата', '2026-08-01T10:00:00Z'],
    [a1, 'withdrawal', 3200.5, 'Магазин продукты', '2026-08-03T14:20:00Z'],
    [a1, 'transfer', -1500, 'Перевод Анне', '2026-08-05T09:15:00Z'],
    [a3, 'transfer', 1500, 'Перевод от Ивана', '2026-08-05T09:15:00Z'],
    [a2, 'deposit', 500, 'Фриланс оплата', '2026-08-10T12:00:00Z'],
    [a4, 'deposit', 999999.99, 'Инициализация', '2026-01-01T00:00:00Z'],
  ];
  for (const t of txs) insertTx.run(...t);
  db.exec('COMMIT');
}

seed();

module.exports = db;
