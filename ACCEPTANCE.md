# Gauntlet Loop / приёмка MVP v0.1.0

Дата: 21.10.2026. Принцип: `PASS` только после реально выполненной проверки; `NOT RUN` не считается `PASS`.

## Итерации

1. **MVP архитектура**: Cloudflare Worker HTTP webhook / scheduled Cron / D1 / Groq / Telegram, схема БД и команды. Внутренний осмотр: PASS.
2. **Автоматизированные тесты**: первоначально 12/12 PASS. По результатам независимой проверки рисков найдено: во время генерации администратор может отключить бота, а пользователь удалить данные. Добавлены `privacy_epoch`, долговременный opt-out и две проверки гонок. Стало 14/14 PASS.
3. **Повторный аудит отправки**: обнаружен непроверенный риск повторной пересылки первых частей длинной газеты. Добавлен тест двухчастного восстановления после отказа API. Итог: 20/20 PASS.
4. **Проверка окружения**: Node.js 22 успешно проверил модули (`npm run check`) и тестовую SQLite-схему. NPM registry из данной среды не разрешается (`EAI_AGAIN`), поэтому реальный build/deploy Wrangler здесь не запускался.

## Матрица результата

| Проверка | Состояние | Доказательство |
|---|---|---|
| JS syntax (`npm run check`) | PASS | Node.js 22 проверил 4 файла |
| Core: время Москвы, выборка, длинные сообщения, промпт, резервный выпуск | PASS | 6/6 Node `--test` |
| Webhook: секретная авторизация | PASS | мок Web Request, запрещённый запрос → 403 |
| Группа: включение только администратором | PASS | SQLite + Telegram API mock |
| Дедупликация и одно издание на день | PASS | два одинаковых сообщения, повтор Cron |
| Groq HTTP 429 | PASS | честный fallback без придуманного AI-анализа |
| Ошибка отправки Telegram | PASS | сохранение тела отчёта и retry без повторного AI |
| `/forgetme`, `/optin`, `/wipe` | PASS | SQLite проверка сохранённых записей |
| Изменение разрешений во время AI-генерации | PASS | тесты обеих гонок |
| Многосоставной отчёт и retry со второй части | PASS | 3800-символьный лимит и next_part |
| Тесты суммарно | PASS | **20/20** |
| GitHub repository created/pushed | NOT RUN | Отсутствует разрешённый API-инструмент для создания нового репозитория |
| Настоящий Wrangler deploy + D1 migrations Cloudflare | NOT RUN | Нет привязанного аккаунта и API токена Cloudflare |
| Настоящий Telegram webhook в группе | NOT RUN | Не созданы Telegram бот/token и target worker URL |
| Настоящий Groq Qwen API response | NOT RUN | Нет переданного в cloud-secret API ключа |
| Два последовательных дня реальной публикации | NOT RUN | Требуется работающий cloud deployment |
| Проверка фактической едкости на сообщениях реального чата | NOT RUN | Требуется чат с согласными участниками и реальный Groq API |

## Ограничения

- Интеграционные тесты используют настоящую SQL-схему в локальной SQLite и подменённые ответы Telegram/Groq. Это полезнее проверки одних строк, но **не** эквивалент cloud-end-to-end тестам.
- Telegram Bot API не даёт универсальной транзакционной exactly-once доставки: если сервер упал после успешной отправки, но до записи прогресса, фрагмент может повториться.
- Приоритет 0 ₽ делает полноценный охват сверхактивных чатов отдельной задачей. MVP берёт равномерную выборку, явно сообщает её размер.
- Платная версия провайдера не нужна для самого приложения, но бесплатные лимиты могут закончиться.

## Release gate

**MVP-код: PASS. Production deployment: NOT RUN.** Не объявлять полноценный релиз, пока Telegram `/enable` → реальные сообщения → `/now` → проверенный Groq response → Cron следующего дня не пройдут на внешней среде.

## Проверка M0.1.1: Cloudflare bootstrap и загрузка в GitHub

- GitHub repository `xxiamadelxx-blip/cherny-vestnik-`: **PASS**, коммит `5e4d1b5` содержит 17 файлов исходной версии.
- GitHub Actions run `39589655838`: **PASS**, автоматические проверки первой версии 15/15.
- Автопоиск существующей D1, создание новой и подстановка UUID в рабочий конфиг: **PASS в мок-тестах**.
- Публикация Worker secrets → health check → Telegram webhook: **PASS в мок-тестах**.
- Полный набор локальных тестов после добавления bootstrap: **20/20 PASS**, Node.js 22.
- Реальная публикация Worker в Cloudflare: **NOT RUN**, отсутствуют подключённые секреты аккаунта в GitHub Actions.
- Настоящий Groq/Telegram webhook: **NOT RUN**, необходимы ключи и созданный Telegram-бот.

**Ни один тест с подменёнными внешними API не заменяет настоящую публикацию.**

## Production evidence — 21 October 2026

**Verified PASS (external services, no group joined):**
- GitHub preflight run [39599577678](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39599577678): real Telegram getMe, Groq Qwen 3.8 27B chat completion, Cloudflare D1 and Workers subdomain queries.
- Initial deployment run [39599750538](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39599750538): **FAIL** at D1 migration because Wrangler v4 rejects unsupported `--yes` argument. No Worker published on that attempt; D1 was created.
- Corrected deployment run [39599888193](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39599888193): **PASS**. D1 migrations applied, Worker and 15-minute cron deployed, secrets uploaded, Telegram setWebhook returned success. URL: `https://cherny-vestnik.xxiamadelxx.workers.dev`.
- Independent live smoke run [39600262813](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39600262813): **PASS**. Telegram getWebhookInfo returned the expected Worker URL; /healthz succeeded; a forged webhook request was rejected with HTTP 403. No group content sent.
- GitHub unit/integration test run [39600262648](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39600262648): **PASS**, 24 automated tests at this stage.

**Not yet verified (must not label complete):**
- Add bot to a disposable test group after explaining data processing to members.
- Test /enable, receipt of real messages, one real /now digest, /status, /forgetme and /wipe.
- Observe next scheduled release at 21:00 Europe/Moscow and Telegram delivery.
- Check AI output quality and factual citation against real messages; adjust satire accordingly.

**Release state:** Cloud infrastructure + real credentials + live webhook smoke PASS. End-to-end chat publication pending. Never publish GitHub Secrets or token values.
