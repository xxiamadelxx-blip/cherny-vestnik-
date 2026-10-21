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

## 300-message simulated Groq run

Run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39603399368

Nine of nine technical checks passed. Exactly 300 fictitious messages were inserted, 85 of them were sampled, real Groq produced a 1600-character report. Telegram delivery was mocked and no real group was involved. Full transcript and report are in reports/simulation-300-chat.json and reports/simulation-300.md. Editorial factuality and exhaustive coverage are not accepted yet; model paraphrases still need human review.


## v0.2 Exhaustive Source Coverage (2026-10-21)

- **PASS** CI 29/29 deterministic tests: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39608399414
- **PASS** real Groq, 300 messages: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39606297928 ; all 300 messages sent through consecutive analysis batches; report: `reports/simulation-300.md`.
- **PASS** Cloudflare Worker + D1 schema migration + production deployment: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39608399502 .
- **PASS** deterministic 1000-message model-mock: all 1000 IDs present in exactly one chunk request, ledger count matches, no duplicate day release.
- **FAIL** first real 1000-message run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39607184045 ; a model reply was truncated, pipeline did not publish partial output. This failure is not considered a successful real 1000-message test.
- **PASS** real Groq 1000 messages: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39608399587 . The actual Groq simulation stage passed: 1000/1000 messages, 25 exhaustive batches, 28 real AI requests, 9/9 simulation assertions. The workflow overall was FAIL because a concurrent GitHub commit caused a non-fast-forward *report push*, not because the AI simulation failed. The generated report was recovered from the run artifact and committed separately as `reports/simulation-1000.md`. Subsequent simulation workflows publish artifacts only, avoiding that race.
- **NOT ACCEPTED** editorial quality: citation IDs are mechanically checked, but nuanced quote attribution and factual inference still require a separate review. Prompts now target stronger, behavior-based satire without defamatory or discriminatory content.
- **PENDING** real Telegram group delivery; no group messages used so far.

No claim of unlimited free throughput: long messages and Groq RPM/TPM/TPD quotas can delay the daily digest. The Worker keeps the incomplete publication pending instead of sampling down to 85.

- **PASS** Full Telegram 4096-character preservation and 30/30 tests: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39610037489
- **PASS** latest Cloudflare deploy and D1 migration: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39610030156
- Full Telegram 4096-character preservation; chat media/voice audio is outside the current text-only contract.

## 2026-10-21 follow-up: harder satire and exhaustive evidence durability

- **PASS**, 34/34 deterministic tests: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39622348739
- **PASS**, production Cloudflare deploy: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39622296820
- Removed the old 85-message sampling implementation. Full input collection uses consecutive `packTranscript` chunks; 1000-message deterministic coverage remains protected by tests.
- Added crash recovery for in-progress jobs and protection of expired source messages while the corresponding digest is unfinished.
- Enhanced intermediate evidence extraction to retain more grounded events, and added hierarchical merge splitting to avoid oversized Groq requests; 34 CI checks include a constrained-context merge test.
- **FAIL**, first real revised 300-message editorial run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39620210210 (evidence exceeded the previous note bound; output was NOT accepted).
- **FAIL**, next real revised 300-message editorial run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39620951720 (Groq HTTP 413).
- **FAIL**, subsequent live editorial run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39622203790 (Groq reply truncated).
- **FAIL**, latest live editorial run: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39622296828 (free Groq rate-limit retries exhausted).
- **Editorial release gate remains NOT ACCEPTED** until the stronger style and factual attributions pass a fresh real-Groq rehearsal when quota is available.
- These test-run FAILs do not reverse the **previous successful real 1000/1000 coverage** result, but they do mean there is **no successful latest editorial sample**. Never label all quality gates PASS.

## v0.2.1 Free Groq quota-aware production controls (2026-10-21)

- **PASS**: 46/46 deterministic tests at https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39629817895
- **PASS**: Cloudflare production deploy, D1 schema, Worker and Telegram webhook registration at https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39629767668 . See the later deploy run for the 0.2.1 version badge.
- `migrations/0003_groq_budget.sql`: organization-scoped durable retry time, 429 backoff, Groq minute-token / daily-request header snapshots, UTC local token estimate. Only quota metadata saved, never secrets or conversations.
- **PASS**: 429 mid-stream stores the provider's `retry-after`, refuses subsequent calls until reset, preserves previously processed evidence, resumes from next unprocessed message IDs. No partial report is published.
- **PASS**: `migrations/0004_digest_reductions.sql` stores hashed intermediate reductions, so a quota pause at an advanced summary stage does not force the previously completed summaries to be generated again.
- **PASS**: `/status` shows next permitted Groq attempt in Moscow local time, local daily token total, and count of fully analyzed messages.
- **PASS**: `/wipe` and permission changes erase private per-chat cached reductions; completed reductions and all messages have bounded retention.
- **PASS**: CI/deploy checks do not spend completion tokens; expensive real 300/1000 message rehearsals require manual dispatch. Preflight manual action still offers full live completion verification.
- Default conservative soft cap: 180000 measured usage tokens per UTC day, threshold 3500 available minute tokens. Organization-wide usage from other apps is invisible to this application's counter; Groq 429 and reset headers remain authoritative.
- **NOT YET ACCEPTED**: a fresh large real-Groq editorial rehearsal after the quota changes, content accuracy review, and Telegram-group end-to-end delivery. Automated quota tests do not prove daily newspaper quality.

The v0.2.1 changes do not add paid APIs or automatically upgrade any account tier.

## v0.2.2 Telegram polling fencing hardening (2026-10-21)

- **PASS**: 73/73 automated tests, including three dedicated SQLite-backed polling lease tests: https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39660585369
- **PASS**: simulated handler crash after first Telegram update; cursor retains the first update and retries the second after restart.
- **PASS**: simulated overlapping Cron invocation after lease expiry; old invocation cannot release the newer lease or roll the cursor backwards.
- **PASS**: second Cron does not start Telegram API request while active lease exists.
- **PENDING**: prove delivery in a real opted-in Telegram test group and inspect an actual group digest. This cannot be claimed from mocked SQLite tests alone.

## 22 October 2026: drained Telegram backlog and renewed live editorial proof

- **PASS**: [82/82 automated tests](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39681301879), including a deterministic **1000 queued Telegram updates** stress test and a **95-update partial-page simulation**. The newspaper snapshot is not begun until **all queued getUpdates pages have been consumed and Telegram returns an empty page**.
- **PASS**: Cloudflare Worker now polls up to `TELEGRAM_POLL_PAGES=4` consecutive pages of up to 40 updates each per minute. If the budget ends or Telegram fails, the digest is postponed, not published from a partial queue.
- **PASS**: [live safe smoke](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39681453590): Telegram webhook is disabled as required for `getUpdates`, Worker `/healthz` reports version `0.2.2`, forged webhook returns 403. This did **not** post to a real Telegram group.
- **FAIL -> FIXED**: A real [editorial trial](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39681341969) detected a quoted joke about a loan falsely attributed to Marta rather than Dima. Unicode-aware attribution checks now reject mismatched speakers, including a Cyrillic name with a Latin lookalike character.
- **PASS**: [real Groq editorial rehearsal](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39682208867), using 30 fictional messages with genuine `qwen/qwen3.8-27b`. 1 live AI request, 4/4 topic groups, 22 valid citation IDs, coarse credit-assertion gate passed, no real Telegram delivery. **88/88 associated unit tests PASS**.
- **PASS**: [latest code deployment](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39682247652) with moderated generation randomness (temperature 0.6), stronger factual guards and full-queue polling. Worker deploy success.
- **NOT ACCEPTED**: actual joined Telegram test-group receipt, next-day automated delivery, independent human review of all factual inferences, and a new 300/1000-message *live* editorial rehearsal with these latest safeguards. The previous real 1000-message run validated exhaustive processing in an older version but does not automatically certify this updated editor.
- **Bounded guarantee**: no silent sampling *after Telegram supplies updates*. If Telegram cannot retain/deliver updates during an outage beyond its own retention policy, no bot can reconstruct missing messages; report separately as an external dependency rather than claiming unlimited capture.

## 22 October: verified evidence and quota-resilient rehearsals

- **PASS**: [92/92 tests](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39684030540), including cited quotes in both formats (source before or after quotation), speaker attribution, fabricated bystanders, quota waits, and blocked-draft privacy retention.
- **PASS (bounded)**: [real Groq 30-message rehearsal](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39682208867). All 30 fictional messages ingested; 4 topics; 22 source ID references. The test predates source-before-quote validation, so it is NOT proof that every literal quote was independently matched.
- **FAIL / QUOTA DEFERRED**: [real 300-message Groq run](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39682506829) stopped due to repeated Groq quota waits and an obsolete 120-second CI wait cap. Do not count it as full-300 completion.
- **IN PROGRESS at time of this entry**: [renewed real 300-message run](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39683130597). Inspect conclusion and artifact before claiming PASS. This run uses its own immutable source SHA, not later fixes.
- **PASS**: [latest Cloudflare Worker deployment](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39683956201) of quota and editorial safeguards.
- **PASS**: updated AI rehearsal scripts record current-run PASS, FAIL or DEFERRED plus actually analyzed source counts; CI removes stale checked-in success report before each attempt.
- **PASS**: after two failed fact-check rewrites the digest enters needs_review, stopping unlimited free-token consumption; admin /retry can resume. The status is visible and blocked source data has a 4-day retention cap.
- **NOT YET ACCEPTED**: complete semantic factuality for arbitrary paraphrases, real opted-in Telegram group delivery, next-day Cron delivery, and a new successful fully audited real 300/1000-message rehearsal.

## Final editorial roast gate, 22 October 2026

**RESULT: FAIL.** Do not declare the satirical MVP finished solely from technical tests.
- [Real Qwen trial 1](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39694346082): 3 independent swear words, 4 stock jokes, false credit attribution; editorial FAIL.
- [Real Qwen trial 2](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39694842657): 3 independent swears and 4 stock jokes; editorial FAIL.
- [Real Qwen trial 3](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39695180117): after three real completions, an unverified verbatim quote caused editorial rejection; editorial FAIL, no real group delivery.
- [Real GPT-OSS comparator](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39695664036): lacked editor-authored adult profanity, weak humor; editorial FAIL. Not enabled in production.
- Independent audit and acceptance criteria: [reports/editorial-quality-audit.md](reports/editorial-quality-audit.md).
- The enhanced mechanical tone rubric in `src/roast-quality.js` is a guardrail, not proof that a joke is funny. Human taste and accurate factual reading remain a release gate.
- Telegram real test group publication is still NOT RUN. No marketing claim of a finished MVP until quality and end-to-end evidence both exist.
