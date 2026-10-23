# MILESTONES.md — Чёрный Вестник

## Правила выполнения
Только работающие критерии, независимая проверка и затем следующий этап. Не принимать тесты как доказательство доставки реальных сообщений. Не повторять уже пройденные проверки без изменения соответствующего кода, регрессии или нового основания. Максимум три цикла исправлений на один блокер; при сохранении проблемы записать `BLOCKED` и перейти к независимой задаче.

**Происхождение карты.** В репозитории до этого файла не было нумерованного `MILESTONES.md`; приведённые ниже коды M0–M4 являются учётной привязкой *уже зафиксированных* результатов из `ACCEPTANCE.md` и `README.md`, а не новым согласованным расширением функций. Без пользовательской канонической версии номеров не следует выдавать такую привязку за ранее утверждённую дорожную карту.

## M0 — Основа бота и облачное выполнение: PASS
Критерии: работающий Worker + D1, Telegram `getUpdates`, команды администратора, развёртывание без ПК и платных серверов.
Доказательства: [production deploy 39768247686](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39768247686); `README.md`. Настоящая групповая публикация не входит в эти технические критерии.

## M1 — Полный охват переписки и сохранение прогресса: PASS (инженерная приёмка)
Критерии: 1000/1000 синтетических сообщений без выборки, сохранение порций в D1, восстановление после остановки, без выпуска на частичных данных.
Доказательства: `tests/exhaustive.test.js`, `tests/polling-backlog.test.js`, [143/143 тестов базовой версии](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39768494714), `reports/simulation-1000.md`. Новые регрессии M4 учитываются отдельно.

## M2 — Квоты, цитаты и безопасность фактов: PASS (технические ограничения)
Критерии: сохранение Groq 429/cooldown, ограниченное количество редакторских исправлений, запрет ложных цитат и привязки чужих слов. Критерий субъективной смешности сюда не входит и не принят.
Доказательства: `src/quota.js`, `src/evidence.js`, `tests/evidence.test.js`, `ACCEPTANCE.md`. Реальная редакторская приёмка остаётся открытой.

## M3 — Фоновый разбор 1000 сообщений в течение дня: PASS (синтетический E2E)
Критерии: 25 последовательных порций до 21:00, повторного Groq-разбора готовых порций нет, резерв на финальную генерацию, защита поздно пришедших сообщений и отказа от обработки.
Доказательства: `tests/preprocess.test.js`, [143/143 GitHub Actions](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39768494714), [production Worker](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39768247686). Это не реальный 1000-message Groq+Telegram production E2E.

## M4 — Строгая граница выпуска по времени: PASS (CI + Cloudflare)
Критерии: запоздавший Cron закрывает окно точно в 21:00 (или настроенное время), после 21:00 сообщения остаются на следующий выпуск, `/now` использует реальное время запроса, частичная очередь Telegram не публикуется, весь CI PASS, актуальный код опубликован в Cloudflare.
- **Цикл 1 / FAIL:** [PR #2, GitHub Actions 39815032308](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39815032308), 143 PASS / 3 FAIL. Ошибка: окно закрывалось с `window_end`, но `window_start` оставался NULL, ломая обработку очереди 95/1000 сообщений.
- **Цикл 1 / FIXED IN CODE, CI PENDING:** [commit 6755474](https://github.com/xxiamadelxx-blip/cherny-vestnik-/commit/6755474ba1f23f790a26319e0fceb6439025a2e1). `window_start` теперь сохраняется независимо от установленного `window_end`; старт первого окна считается от его фактической границы, а не от запоздавшего времени Cron.
- **Независимая проверка:** [PR #2](https://github.com/xxiamadelxx-blip/cherny-vestnik-/pull/2) содержит дополнительные тесты для `/now` и первого отложенного выпуска. Ожидается CI на исправленной версии; старые 143 PASS не засчитываются вместо этой проверки.
- **Следующий шаг:** дождаться заключения нового CI; при PASS слить только проверенные тесты, выполнить Cloudflare deploy и пометить M4 PASS. При FAIL исправить конкретную регрессию (не более ещё двух циклов).

### Gauntlet Loop — цикл 2: техническая регрессия закрыта
- **PASS (independent CI):** [146/146 tests](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39817581102) at QA head `dc12fb0`. Previously failing getUpdates backlog tests (95/1000) now pass; the two additional tests prove manual `/now` and delayed first-ever scheduled issue.
- **PASS (integration):** [PR #3 merged](https://github.com/xxiamadelxx-blip/cherny-vestnik-/pull/3), main `b241075`. PR #2 was superseded after its genuinely failed 143/146 run, not silently re-labelled.
- **PASS (secondary narrow SQL check):** in-memory SQLite reproduced a frozen `window_end` and missing `window_start`, confirmed a deterministic 21:00 cutoff, persistence of start, all 95 pre-cutoff posts, and exclusion of 10 later posts. This check supports, but does NOT replace, the 146-test independent run.
- **OPEN (production proof):** last verified Cloudflare deploy [39768247686](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39768247686) built `2e26d910`. No independently verified Worker deployment yet includes `6755474` or merged `b241075`. Treat scheduled-cutoff fix as **DEPLOY BLOCKED**, not M4 PASS. The connected GitHub action API can read logs and re-run historical jobs but has no supported new workflow-dispatch action; re-running a historical deploy would deploy the old SHA.
- **Next exact operation:** [dispatch the existing Deploy workflow](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/workflows/deploy.yml) on main `b241075`, confirm its run conclusion PASS and Worker code revision, then close M4. Do not repeat accepted M0–M3 tests without a reason.

## Уже известные следующие внешние критерии (без выдумывания новых M-этапов)
1. **Реальный Telegram group E2E: NOT RUN.** Группа должна добровольно добавить существующего бота и включить сбор, затем проверить `/enable → сообщения → /now → следующий Cron`; ни один синтетический тест не заменяет этот критерий.
2. **Реальный Qwen 1000-message daytime E2E: NOT RUN** на актуальном SHA и в рамках доступной бесплатной квоты. Ранее 1000/1000 были проверены в старом вечернем конвейере, а текущий daytime вариант проверен синтетически.
3. **Приёмка текста редактором: NOT ACCEPTED.** Успешные численные критерии брани/ссылок не доказывают, что статья смешная и свободна от фактических выдумок.

### Текущая остановка
**Открытый этап: M4, deployment BLOCKED.** Независимый CI на исправленном коде PASS 146/146; облачная публикация этой версии не доказана. После PASS деплоя перейти к реальному тестовому Telegram E2E; пока внешний блокер сохраняется, допустимы только независимые задачи из существующих критериев (не новые улучшения).

### Gauntlet Loop — deployment attempt 1
- **TRIGGERED, RESULT PENDING:** [commit e8e7aa6](https://github.com/xxiamadelxx-blip/cherny-vestnik-/commit/e8e7aa65a1c2a08eaa2539e4f88df57d0ba3e7bb) changes only the deploy workflow comment, triggering its existing `push` path filter on `main` to deploy the already independently tested M4 source. No production success is claimed until a matching GitHub Actions run completes successfully.
- **Next step:** inspect the new deployment run and its logs, then record PASS/FAIL; if PASS, close M4 and proceed to the existing real Telegram group E2E criterion. Do not rerun unrelated accepted tests.

### Deployment attempt 1 — evidence-based result
- **BLOCKED (external CI trigger):** after [e8e7aa6](https://github.com/xxiamadelxx-blip/cherny-vestnik-/commit/e8e7aa65a1c2a08eaa2539e4f88df57d0ba3e7bb), the GitHub Actions runs listing still shows no new deploy run; latest confirmed production run is `39768247686` for old SHA `2e26d910`. Connector file commits do not themselves establish an Actions execution. This is **not a successful deploy**.
- **M4 remains ACTIVE / DEPLOY BLOCKED**, technical CI 146/146 PASS. No more cosmetic workflow edits or speculative retries. The available connector has no new `workflow_dispatch` action.
- **Required external action:** on Android, open [Deploy workflow](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/workflows/deploy.yml), select `main`, tap `Run workflow` once. Then inspect the run conclusion and Worker version; on PASS mark M4 accepted.
- **Independent next task:** prepare the already specified opt-in Telegram group E2E checklist and record real `/enable → messages → /now → scheduled next issue` results only after the user has actually added the bot. Do not claim real Telegram delivery from mocks.


### Финальная приёмка M4 — 23 октября 2026

- **PASS, independent CI:** [146/146](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39817581102) на QA-кандидате; новые тесты проверяют `/now` и опоздавший Cron, а регрессия на 95/1000 Telegram-сообщений устранена.
- **PASS, Cloudflare production deploy:** [39823168790](https://github.com/xxiamadelxx-blip/cherny-vestnik-/actions/runs/39823168790), SHA `6755474ba1f2`, `main`, SUCCESS. Журнал подтверждает 144/144 PASS на том SHA, успешную публикацию `cherny-vestnik`, Telegram `getUpdates` и Worker URL `https://cherny-vestnik.xxiamadelxx.workers.dev`.
- **PASS, production source equivalence:** compare GitHub `6755474ba1f2...cd28d9f0c836` подтверждает, что после развёрнутого SHA менялись только `.github/workflows/deploy.yml`, `tests/preprocess.test.js` и `MILESTONES.md`. Код `src/**`, схема и Worker-конфигурация остались идентичны. Деплой новой документации не требуется.
- **PASS, integrity boundary:** автоматический выпуск закрывается ровно в заданное время; после этой границы сообщения остаются на следующий выпуск. Досрочная `/now` сохраняет своё собственное время. Частичная Telegram-очередь не может автоматически запускать выпуск.
- **M4 CLOSED.** Исправлять или тестировать эти функции заново без реальной регрессии запрещено.

### Следующая независимая задача после M4

1. **Telegram group E2E: BLOCKED (внешнее действие).** Нет подтверждения, что существующий бот добавлен в добровольно подключённую тестовую группу. Реальные `/enable → сообщения → /now → следующий Cron` проверить до этого нельзя. Не симулировать приёмку реального Telegram.
2. **Real Qwen 1000-message daytime E2E: OPEN.** Тестировать реальный Groq, а не mock, на актуальном конвейере фоновых D1-порций, с явным `PASS/FAIL/QUOTA_DEFERRED`, количеством обработанных сообщений и ссылками на выпуск. Не тратить квоты без учёта и не объявлять 1000/1000 по неполному прогону.
3. **Human editorial quality: NOT ACCEPTED.** Независимо от технического PASS проверить текст и цитаты на реальном выпуске, не подменять человеческую оценку количеством мата.

**Текущий этап работы:** M4 PASS, следующий независимый критерий — реальный 1000-message daytime Groq trial. Цель: доказательная приёмка, а не новые функции или редизайн.
