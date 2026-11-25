# 🏦 Bank API Tests

Автоматизированное тестирование банковского API с использованием **Postman / Newman** и **GitHub Actions (CI/CD)**.

## 📁 Структура проекта

* `server.js` — тестовый банковский сервер на Node.js (с поддержкой WebSocket `ws`).
* `bank-api.json` — коллекция API-запросов и проверок (экспорт из Postman).
* `bank-env.json` — переменные окружения для запуска тестов.
* `.github/workflows/tests.yml` — конфигурация автоматического запуска тестов в GitHub Actions при каждом `push` в ветку `main`.
* `graphql-server/` — дополнительный модуль GraphQL-сервера.

## 🚀 Как запустить локально

1. **Установите зависимости:**
   ```bash
   npm install
   ```

2. **Установите Newman** (если еще не установлен глобально):
   ```bash
   npm install -g newman
   ```

3. **Запустите банковский сервер** (в первом окне терминала):
   ```bash
   npm start
   ```

4. **Запустите автотесты** (во втором окне терминала):
   ```bash
   npm test
   ```
   *(выполнит команду `newman run bank-api.json -e bank-env.json --delay-request 300`)*

