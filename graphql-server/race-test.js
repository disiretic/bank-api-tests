// race-test.js — проверка race condition в мутации transfer
// Запуск: node race-test.js (сервер должен быть уже запущен на порту 3004)

const URL = 'http://localhost:3004/graphql';

async function gql(query, token) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

(async () => {
  // 1. Логинимся Иваном, получаем токен
  const loginRes = await gql(`mutation { login(username: "ivan_petrov", password: "Passw0rd!") { token } }`);
  const token = loginRes.data.login.token;

  // 2. Смотрим баланс до атаки
  const before = await gql(`query { account(id: 1) { balance } }`);
  console.log('Баланс ДО:', before.data.account.balance);

  // 3. Отправляем ДВА одинаковых перевода ОДНОВременно (Promise.all, а не по очереди)
  const transferQuery = `mutation { transfer(fromAccountId: 1, toAccountId: 3, amount: 100000) { id amount } }`;

  console.log('Отправляю 2 перевода по 100000 ОДНОВРЕМЕННО...');
  const [r1, r2] = await Promise.all([
    gql(transferQuery, token),
    gql(transferQuery, token),
  ]);
  console.log('Ответ 1:', JSON.stringify(r1));
  console.log('Ответ 2:', JSON.stringify(r2));

  // 4. Смотрим баланс после — если оба перевода прошли, баланс уйдёт в минус,
  //    хотя каждый по отдельности был в пределах остатка (100000 < 154320.5)
  const after = await gql(`query { account(id: 1) { balance } }`);
  console.log('Баланс ПОСЛЕ:', after.data.account.balance);
})();
