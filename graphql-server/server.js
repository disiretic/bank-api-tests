// server.js — Учебный GraphQL сервер банковского приложения
// Порт: 3004 (по аналогии с server.js:3000, billing:3001, referral:3002, analytics:3003)
//
// ВНИМАНИЕ: сервер содержит НАМЕРЕННЫЕ уязвимости для практики тестирования
// безопасности (по аналогии с DIVA / OWASP API Security Top 10).
// Список уязвимостей — см. VULNERABILITIES.md

const express = require('express');
const { ApolloServer, gql, AuthenticationError } = require('apollo-server-express');
const jwt = require('jsonwebtoken');
const db = require('./db');

const PORT = 3004;
const JWT_SECRET = 'super-secret-bank-key'; // намеренно слабый/захардкоженный секрет

// ---------- GraphQL Schema ----------
const typeDefs = gql`
  type User {
    id: ID!
    username: String!
    fullName: String!
    role: String!
    accounts: [Account!]!
  }

  type Account {
    id: ID!
    number: String!
    balance: Float!
    currency: String!
    owner: User!
    cards: [Card!]!
    transactions: [Transaction!]!
  }

  type Card {
    id: ID!
    number: String!
    cvv: String!
    expiry: String!
  }

  type Transaction {
    id: ID!
    type: String!
    amount: Float!
    description: String
    createdAt: String!
    account: Account!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  type Query {
    "Вернуть текущего пользователя по токену"
    me: User
    "Получить пользователя по ID — уязвимо к IDOR: авторизация не проверяется"
    user(id: ID!): User
    "Получить всех пользователей — раскрытие данных, нет проверки роли"
    users: [User!]!
    "Получить счёт по ID — уязвимо к IDOR"
    account(id: ID!): Account
    "Поиск транзакций по описанию — уязвимо к SQL-инъекции"
    searchTransactions(query: String!): [Transaction!]!
  }

  type Mutation {
    login(username: String!, password: String!): AuthPayload
    "Перевод между счетами — отсутствует проверка владения исходным счётом"
    transfer(fromAccountId: ID!, toAccountId: ID!, amount: Float!): Transaction
    "Создание карты — уязвимо к mass assignment (можно передать чужой accountId)"
    createCard(accountId: ID!, number: String!, cvv: String!, expiry: String!): Card
  }
`;

// ---------- Helpers ----------
function rowToUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, fullName: row.full_name, role: row.role };
}
function rowToAccount(row) {
  if (!row) return null;
  return { id: row.id, number: row.number, balance: row.balance, currency: row.currency, userId: row.user_id };
}
function rowToCard(row) {
  return { id: row.id, number: row.number, cvv: row.cvv, expiry: row.expiry, accountId: row.account_id };
}
function rowToTx(row) {
  return {
    id: row.id, type: row.type, amount: row.amount, description: row.description,
    createdAt: row.created_at, accountId: row.account_id,
  };
}

// ---------- Resolvers ----------
const resolvers = {
  Query: {
    me: (_, __, ctx) => {
      if (!ctx.user) return null;
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
      return rowToUser(row);
    },
    // УЯЗВИМОСТЬ (IDOR): нет проверки, что ctx.user имеет право смотреть этого user
    user: (_, { id }) => {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      return rowToUser(row);
    },
    // УЯЗВИМОСТЬ: список всех пользователей доступен без проверки роли admin
    users: () => {
      return db.prepare('SELECT * FROM users').all().map(rowToUser);
    },
    // УЯЗВИМОСТЬ (IDOR): любой авторизованный (и даже неавторизованный) может
    // запросить чужой счёт по id, зная только число
    account: (_, { id }) => {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      return rowToAccount(row);
    },
    // УЯЗВИМОСТЬ (SQL Injection): строка подставляется напрямую в SQL-запрос
    searchTransactions: (_, { query }) => {
      const sql = `SELECT * FROM transactions WHERE description LIKE '%${query}%'`;
      try {
        const rows = db.prepare(sql).all();
        return rows.map(rowToTx);
      } catch (e) {
        // УЯЗВИМОСТЬ: подробная ошибка БД возвращается клиенту как есть
        throw new Error(`DB error: ${e.message} | SQL: ${sql}`);
      }
    },
  },

  Mutation: {
    login: (_, { username, password }) => {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?')
        .get(username, password);
      if (!row) throw new AuthenticationError('Неверный логин или пароль');
      const token = jwt.sign({ id: row.id, role: row.role }, JWT_SECRET, { expiresIn: '7d' });
      return { token, user: rowToUser(row) };
      // УЯЗВИМОСТЬ: нет rate limiting/лока — возможен brute-force подбор пароля
    },

    // УЯЗВИМОСТЬ (Broken Object Level Authorization):
    // не проверяется, что fromAccountId принадлежит ctx.user
    transfer: async (_, { fromAccountId, toAccountId, amount }, ctx) => {
      const from = db.prepare('SELECT * FROM accounts WHERE id = ?').get(fromAccountId);
      const to = db.prepare('SELECT * FROM accounts WHERE id = ?').get(toAccountId);
      if (!from || !to) throw new Error('Счёт не найден');
      if (amount <= 0) throw new Error('Некорректная сумма');
      if (amount > from.balance) throw new Error('Недостаточно средств на счёте');
      // УЯЗВИМОСТЬ (race condition): искусственная задержка имитирует реальную
      // задержку сети/БД между проверкой баланса и списанием. За это окно
      // может успеть проскочить второй параллельный запрос с тем же from.balance.
      await new Promise((resolve) => setTimeout(resolve, 300));
      db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(amount, fromAccountId);
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(amount, toAccountId);
      const now = new Date().toISOString();
      const info = db.prepare(
        'INSERT INTO transactions (account_id, type, amount, description, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(fromAccountId, 'transfer', -amount, `Перевод на счёт ${toAccountId}`, now);
      const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
      return rowToTx(row);
    },

    // УЯЗВИМОСТЬ (Mass Assignment): любой может привязать карту к чужому accountId
    createCard: (_, { accountId, number, cvv, expiry }) => {
      const info = db.prepare(
        'INSERT INTO cards (account_id, number, cvv, expiry) VALUES (?, ?, ?, ?)'
      ).run(accountId, number, cvv, expiry);
      const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(info.lastInsertRowid);
      return rowToCard(row);
    },
  },

  User: {
    accounts: (user) => db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(user.id).map(rowToAccount),
  },

  Account: {
    owner: (account) => rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(account.userId)),
    cards: (account) => db.prepare('SELECT * FROM cards WHERE account_id = ?').all(account.id).map(rowToCard),
    // УЯЗВИМОСТЬ (nested resolver, N+1 / DoS): нет пагинации, лимита или complexity-анализа —
    // глубокая вложенность account->transactions->account->transactions... не ограничена
    transactions: (account) => db.prepare('SELECT * FROM transactions WHERE account_id = ?').all(account.id).map(rowToTx),
  },

  Transaction: {
    account: (tx) => rowToAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(tx.accountId)),
  },
};

// ---------- Server bootstrap ----------
async function start() {
  const app = express();

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // УЯЗВИМОСТЬ: introspection и GraphQL Playground включены даже в "production"-подобном режиме
    introspection: true,
    debug: true, // УЯЗВИМОСТЬ: полные stack trace в ответах об ошибках
    context: ({ req }) => {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');
      try {
        const user = jwt.verify(token, JWT_SECRET);
        return { user };
      } catch {
        return { user: null };
      }
    },
  });

  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });

  app.get('/', (_req, res) => {
    res.send('Bank GraphQL server. Playground: /graphql');
  });

  app.listen(PORT, () => {
    console.log(`🚀 GraphQL сервер запущен: http://localhost:${PORT}${server.graphqlPath}`);
    console.log(`   Тестовые пользователи: ivan_petrov/Passw0rd!, anna_smirnova/QwertY123, admin/admin123`);
  });
}

start();
