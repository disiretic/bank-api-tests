const http = require('http');

// ========== База данных ==========
const db = {
  users: [
    { id: 1, email: 'ivan@bank.ru',   password: 'ivan123',   name: 'Иван Петров',   role: 'user',  blocked: false, failedAttempts: 0 },
    { id: 2, email: 'anna@bank.ru',   password: 'anna123',   name: 'Анна Сидорова', role: 'user',  blocked: false, failedAttempts: 0 },
    { id: 3, email: 'admin@bank.ru',  password: 'admin123',  name: 'Администратор', role: 'admin', blocked: false, failedAttempts: 0 },
  ],
  accounts: [
    { id: 1, userId: 1, number: '40817810000000000001', currency: 'RUB', balance: 1500000.00, frozen: false },
    { id: 2, userId: 1, number: '40817800000000000001', currency: 'RUB', balance: 0.00, frozen: false },
    { id: 3, userId: 1, number: '40817840000000000001', currency: 'USD', balance: 1000.00,   frozen: false },
    { id: 4, userId: 2, number: '40817810000000000002', currency: 'RUB', balance: 75000.50,  frozen: false },
    { id: 5, userId: 2, number: '40817810000000000003', currency: 'RUB', balance: 500.00,    frozen: true  }, // заморожен
  ],
  transactions: [],
  tokens: {},      // { token: { userId, expiresAt } }
  otpCodes: {},    // { userId: { code, expiresAt } } — двухфакторная аутентификация
  limits: {
    perOperation: 100000,   // лимит одной операции (руб)
    perDay: 300000,         // суточный лимит (руб)
  },
};

// ========== Вспомогательные функции ==========
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('application/json')) {
        return reject({ status: 400, error: `Неверный Content-Type: "${ct}". Ожидается application/json` });
      }
      try { resolve(JSON.parse(body)); }
      catch (e) { reject({ status: 400, error: 'Невалидный JSON в теле запроса' }); }
    });
  });
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 цифр
}

function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const session = db.tokens[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) { delete db.tokens[token]; return null; }
  return db.users.find(u => u.id === session.userId) || null;
}

// Считаем сумму переводов пользователя за сегодня
function getDailySpent(userId) {
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  return db.transactions
    .filter(t => t.fromUserId === userId && new Date(t.createdAt) >= startOfDay && t.status === 'success')
    .reduce((sum, t) => sum + t.amount, 0);
}

// Точное округление до 2 знаков (избегаем проблему float)
function round2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

// ========== Сервер ==========
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, 'http://localhost:3000');
  const path   = url.pathname;
  const method = req.method;

  console.log(`\n[${new Date().toLocaleTimeString()}] ${method} ${path}`);

  try {

    // --------------------------------------------------
    // POST /auth/login — шаг 1: проверка пароля
    // --------------------------------------------------
    if (method === 'POST' && path === '/auth/login') {
      const body = await parseBody(req);
      if (!body.email)    return sendJSON(res, 400, { error: 'Поле email обязательно' });
      if (!body.password) return sendJSON(res, 400, { error: 'Поле password обязательно' });

      const user = db.users.find(u => u.email === body.email);

      if (!user || user.password !== body.password) {
        if (user) {
          user.failedAttempts++;
          if (user.failedAttempts >= 3) {
            user.blocked = true;
            return sendJSON(res, 403, { error: 'Аккаунт заблокирован после 3 неверных попыток. Обратитесь в поддержку.' });
          }
          return sendJSON(res, 401, { error: `Неверный пароль. Осталось попыток: ${3 - user.failedAttempts}` });
        }
        return sendJSON(res, 401, { error: 'Неверный email или пароль' });
      }

      if (user.blocked) return sendJSON(res, 403, { error: 'Аккаунт заблокирован. Обратитесь в поддержку.' });

      user.failedAttempts = 0;

      // Генерируем OTP (двухфакторка)
      const otp = generateOTP();
      db.otpCodes[user.id] = { code: otp, expiresAt: Date.now() + 5 * 60 * 1000 }; // 5 минут

      // В реальном банке OTP пришёл бы по SMS — мы показываем его в ответе для учебных целей
      return sendJSON(res, 200, {
        message:  'Пароль верный. Введите OTP-код для завершения входа.',
        otp_hint: `[ТЕСТОВЫЙ РЕЖИМ] Ваш OTP-код: ${otp}`,
        next:     'POST /auth/verify-otp',
        user_id:  user.id,
      });
    }

    // --------------------------------------------------
    // POST /auth/verify-otp — шаг 2: подтверждение OTP
    // --------------------------------------------------
    if (method === 'POST' && path === '/auth/verify-otp') {
      const body = await parseBody(req);
      if (!body.user_id) return sendJSON(res, 400, { error: 'Поле user_id обязательно' });
      if (!body.otp)     return sendJSON(res, 400, { error: 'Поле otp обязательно' });

      const otpSession = db.otpCodes[body.user_id];
      if (!otpSession)                       return sendJSON(res, 400, { error: 'Сначала выполните POST /auth/login' });
      if (Date.now() > otpSession.expiresAt) return sendJSON(res, 400, { error: 'OTP-код истёк. Войдите заново.' });
      if (otpSession.code !== String(body.otp)) return sendJSON(res, 401, { error: 'Неверный OTP-код' });

      delete db.otpCodes[body.user_id];

      const user  = db.users.find(u => u.id === body.user_id);
      const token = generateToken();
      db.tokens[token] = { userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 };

      return sendJSON(res, 200, {
        token,
        expires_in: '30 минут',
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    }

    // --------------------------------------------------
    // POST /auth/logout
    // --------------------------------------------------
    if (method === 'POST' && path === '/auth/logout') {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) delete db.tokens[authHeader.slice(7)];
      return sendJSON(res, 200, { message: 'Сессия завершена' });
    }

    // --------------------------------------------------
    // Всё ниже — только для авторизованных
    // --------------------------------------------------
    const user = authenticate(req);
    if (!user) return sendJSON(res, 401, { error: 'Требуется авторизация', hint: 'Authorization: Bearer <token>' });

    // --------------------------------------------------
    // GET /accounts — счета текущего пользователя
    // --------------------------------------------------
    if (method === 'GET' && path === '/accounts') {
      const accounts = db.accounts.filter(a => a.userId === user.id);
      return sendJSON(res, 200, { accounts });
    }

    // --------------------------------------------------
    // GET /accounts/:id — один счёт
    // --------------------------------------------------
    if (method === 'GET' && path.startsWith('/accounts/')) {
      const id      = parseInt(path.split('/')[2]);
      const account = db.accounts.find(a => a.id === id);
      if (!account) return sendJSON(res, 404, { error: `Счёт с id=${id} не найден` });
      if (account.userId !== user.id && user.role !== 'admin') {
        return sendJSON(res, 403, { error: 'Нет доступа к чужому счёту' });
      }
      return sendJSON(res, 200, account);
    }

    // --------------------------------------------------
    // POST /transfers — перевод между счетами
    // --------------------------------------------------
    if (method === 'POST' && path === '/transfers') {
      const body = await parseBody(req);

      // Валидация полей
      if (!body.from_account) return sendJSON(res, 400, { error: 'Поле from_account обязательно' });
      if (!body.to_account)   return sendJSON(res, 400, { error: 'Поле to_account обязательно' });
      if (!body.amount)       return sendJSON(res, 400, { error: 'Поле amount обязательно' });
      if (typeof body.amount !== 'number') return sendJSON(res, 400, { error: 'amount должен быть числом' });
      if (body.amount <= 0)   return sendJSON(res, 400, { error: 'amount должен быть больше нуля' });
      if (body.from_account === body.to_account) return sendJSON(res, 400, { error: 'Нельзя переводить на тот же счёт' });

      const amount = round2(body.amount);

      // Находим счета
      const fromAccount = db.accounts.find(a => a.number === body.from_account);
      const toAccount   = db.accounts.find(a => a.number === body.to_account);

      if (!fromAccount) return sendJSON(res, 404, { error: `Счёт отправителя не найден: ${body.from_account}` });
      if (!toAccount)   return sendJSON(res, 404, { error: `Счёт получателя не найден: ${body.to_account}` });

      // Проверяем что счёт принадлежит текущему пользователю
      if (fromAccount.userId !== user.id) return sendJSON(res, 403, { error: 'Нет доступа к счёту отправителя' });

      // Проверяем заморозку
      if (fromAccount.frozen) return sendJSON(res, 403, { error: 'Счёт отправителя заморожен' });
      if (toAccount.frozen)   return sendJSON(res, 403, { error: 'Счёт получателя заморожен' });

      // Проверяем валюту
      if (fromAccount.currency !== toAccount.currency) {
        return sendJSON(res, 400, { error: `Конвертация валют не поддерживается. Счёт отправителя: ${fromAccount.currency}, счёт получателя: ${toAccount.currency}` });
      }

      // Проверяем лимиты
      if (amount > db.limits.perOperation) {
        return sendJSON(res, 400, { error: `Превышен лимит одной операции: ${db.limits.perOperation} руб.` });
      }

      const dailySpent = getDailySpent(user.id);
      if (dailySpent + amount > db.limits.perDay) {
        return sendJSON(res, 400, {
          error: `Превышен суточный лимит переводов: ${db.limits.perDay} руб.`,
          daily_spent:     dailySpent,
          daily_remaining: round2(db.limits.perDay - dailySpent),
        });
      }

      // Проверяем баланс
      if (fromAccount.balance < amount) {
        return sendJSON(res, 400, {
          error:     'Недостаточно средств',
          balance:   fromAccount.balance,
          required:  amount,
          shortage:  round2(amount - fromAccount.balance),
        });
      }

      // Выполняем перевод — атомарно
      fromAccount.balance = round2(fromAccount.balance - amount);
      toAccount.balance   = round2(toAccount.balance   + amount);

      const transaction = {
        id:          db.transactions.length + 1,
        fromAccount: fromAccount.number,
        toAccount:   toAccount.number,
        fromUserId:  user.id,
        toUserId:    toAccount.userId,
        amount,
        currency:    fromAccount.currency,
        status:      'success',
        createdAt:   new Date().toISOString(),
      };
      db.transactions.push(transaction);

      return sendJSON(res, 201, {
        message:           'Перевод выполнен успешно',
        transaction,
        new_balance:       fromAccount.balance,
        daily_spent:       round2(dailySpent + amount),
        daily_remaining:   round2(db.limits.perDay - dailySpent - amount),
      });
    }

    // --------------------------------------------------
    // GET /transactions — история операций
    // --------------------------------------------------
    if (method === 'GET' && path === '/transactions') {
      const txs = user.role === 'admin'
        ? db.transactions
        : db.transactions.filter(t => t.fromUserId === user.id || t.toUserId === user.id);
      return sendJSON(res, 200, { transactions: txs, total: txs.length });
    }

    // --------------------------------------------------
    // GET /limits — текущие лимиты и остаток
    // --------------------------------------------------
    if (method === 'GET' && path === '/limits') {
      const dailySpent = getDailySpent(user.id);
      return sendJSON(res, 200, {
        per_operation:   db.limits.perOperation,
        per_day:         db.limits.perDay,
        daily_spent:     dailySpent,
        daily_remaining: round2(db.limits.perDay - dailySpent),
      });
    }

    // --------------------------------------------------
    // GET /admin/accounts — все счета (только admin)
    // --------------------------------------------------
    if (method === 'GET' && path === '/admin/accounts') {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Требуется роль admin' });
      return sendJSON(res, 200, { accounts: db.accounts });
    }

    // --------------------------------------------------
    // PATCH /admin/accounts/:id/freeze — заморозить/разморозить (admin)
    // --------------------------------------------------
    if (method === 'PATCH' && path.includes('/admin/accounts/') && path.endsWith('/freeze')) {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'Требуется роль admin' });
      const id      = parseInt(path.split('/')[3]);
      const account = db.accounts.find(a => a.id === id);
      if (!account) return sendJSON(res, 404, { error: `Счёт с id=${id} не найден` });
      account.frozen = !account.frozen;
      return sendJSON(res, 200, {
        message: account.frozen ? `Счёт ${account.number} заморожен` : `Счёт ${account.number} разморожен`,
        account,
      });
    }

    sendJSON(res, 404, { error: `Маршрут ${method} ${path} не найден` });

  } catch (err) {
    if (err.status) return sendJSON(res, err.status, { error: err.error });
    console.error(err);
    sendJSON(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

server.listen(3000, () => {
  console.log('Банк запущен: http://localhost:3000\n');
  console.log('Пользователи:');
  console.log('  ivan@bank.ru   / ivan123   — баланс 150 000 RUB, 1000 USD');
  console.log('  anna@bank.ru   / anna123   — баланс 75 000 RUB (+ замороженный счёт)');
  console.log('  admin@bank.ru  / admin123  — администратор');
  console.log('\nСчета Ивана:');
  console.log('  40817810000000000001 (RUB)');
  console.log('  40817840000000000001 (USD)');
  console.log('\nСчета Анны:');
  console.log('  40817810000000000002 (RUB, активный)');
  console.log('  40817810000000000003 (RUB, заморожен)');
  console.log('\nМаршруты:');
  console.log('  POST  /auth/login           — шаг 1: пароль');
  console.log('  POST  /auth/verify-otp      — шаг 2: OTP-код');
  console.log('  POST  /auth/logout          — выход');
  console.log('  GET   /accounts             — мои счета');
  console.log('  GET   /accounts/:id         — один счёт');
  console.log('  POST  /transfers            — перевод');
  console.log('  GET   /transactions         — история операций');
  console.log('  GET   /limits               — лимиты и остаток');
  console.log('  GET   /admin/accounts       — все счета (admin)');
  console.log('  PATCH /admin/accounts/:id/freeze  — заморозка (admin)');
});
