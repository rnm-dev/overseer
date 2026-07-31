# Техническое задание: переход Codex-адаптера Peon на app-server

Статус: завершено; документ сохранён как исторический дизайн
Дата: 2026-07-13  
Область: только backend `codex`; интеграция `claude-code` остаётся без изменений

## 1. Резюме решения

Peon должен заменить запуск отдельного `codex exec --json` на каждый turn одним управляемым процессом `codex app-server`, работающим через JSON-RPC 2.0 поверх stdio. Один app-server обслуживает множество Peon-сессий: каждой Peon-сессии соответствует отдельный Codex thread, каждому пользовательскому сообщению — отдельный Codex turn.

Миграция выполняется не big bang, а через второй адаптер за feature flag. Старый `codex exec` сохраняется как fallback до прохождения нагрузочных тестов и периода наблюдения; protocol spike уже пройден.

Главная причина перехода — более полный lifecycle-протокол, включая `fileChange` items и `turn/diff/updated`. Ускорение follow-up и уменьшение числа процессов являются дополнительными преимуществами, но не самостоятельным критерием успеха.

Protocol spike выполнен на фактически используемом Peon runtime `codex-cli 0.144.1`. Generated schema и runtime trace подтвердили, что `ThreadItem.fileChange.changes[]` уже содержит `path`, structured `kind` и отдельный `diff` конкретного tool invocation. Два последовательных Edit одного файла дали независимые fragments `beta→gamma` и `gamma→delta`, тогда как `turn/diff/updated` после второго Edit был cumulative `beta→delta`. Следовательно, per-edit source of truth — только `fileChange` item; aggregate turn diff для transcript не используется.

## 2. Цели

1. Поддерживать несколько одновременных Codex-сессий через один app-server.
2. Сохранить публичные API Peon и provider-neutral transcript format.
3. Поддержать start, follow-up, steer/interrupt, cancel, timeout, daemon restart и resume.
4. Получать и сохранять максимально точный per-edit unified diff на границе выполнения инструмента.
5. Сохранить идентичность событий в transcript snapshot и SSE stream.
6. Ограничить память, очередь запросов, размер diff и активный параллелизм.
7. Обеспечить постепенный rollout с быстрым откатом на `codex exec`.

## 3. Не входит в объём

- Миграция Claude Code на другой протокол.
- Изменение `/agent/v1` и operator API без отдельной необходимости.
- Использование WebSocket transport: первая версия использует локальный stdio.
- Вынос app-server на другую машину.
- Отображение chain-of-thought или непубличного reasoning.
- Реконструкция исторических diff для уже сохранённых событий.
- Вычисление per-edit diff из текущего Git worktree после завершения tool call.

## 4. Основания и официальный контракт

Codex app-server — интерфейс для rich clients, включая VS Code extension. Он использует JSON-RPC-подобные сообщения и поддерживает stdio JSONL. Клиент обязан выполнить `initialize`, затем отправить `initialized`. Основные операции: `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`; прогресс приходит через notifications.

Официальные источники:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Turn events](https://learn.chatgpt.com/docs/app-server#turn-events)
- [Item deltas](https://learn.chatgpt.com/docs/app-server#item-deltas)
- [Developer commands](https://learn.chatgpt.com/docs/developer-commands#command-overview)

Документация явно указывает:

- `turn/diff/updated` содержит последний агрегированный unified diff всех файловых изменений turn;
- legacy `item/fileChange/outputDelta` deprecated;
- актуальные клиенты должны использовать `fileChange` items и `turn/diff/updated`;
- схемы можно генерировать установленным CLI через `codex app-server generate-ts` и `generate-json-schema`;
- thread может быть выгружен после `thread/unsubscribe`, если больше нет подписчиков;
- WebSocket имеет bounded ingress queue и ошибку overload, но stdio остаётся предпочтительным локальным транспортом для Peon.

Версия протокола не должна предполагаться по документации: source of truth для сборки — сгенерированная schema той версии `codex`, которую поддерживает Peon.

## 5. Текущее состояние Peon

Сегодня:

- `sessions service` создаёт отдельный `AgentRun` на каждый start/resume;
- `agentExecutor.ts` выбирает адаптер `claude-code` или `codex`;
- `agents/codex.ts` запускает `codex exec --json` или `codex exec resume`;
- `spawnJsonAgent.ts` парсит stdout JSONL и связывает lifetime дочернего процесса с одним run;
- `activeRuns: Map<sessionId, AgentRun>` хранит отдельный процесс каждого активного turn;
- `backendSessionId` хранит Codex thread id;
- нормализованные события сразу append-only записываются в `<session>.jsonl`, затем тем же объектом отправляются в SSE;
- daemon не ограничивает количество параллельных интерактивных сессий;
- follow-up во время активного run убивает процесс, ждёт exit и запускает `--resume`;
- restart помечает активные сессии interrupted и затем может автоматически их resume;
- текущий `file_change` в `codex exec --json` обычно содержит только `path` и `kind`, поэтому patch недоступен.

Сохраняемые инварианты:

1. Сначала append transcript, затем live emit того же canonical event.
2. `SessionRecord.backendSessionId` остаётся provider-owned thread id.
3. Исторические transcript events читаются без миграции файла.
4. Завершённая Peon-сессия может получить follow-up в том же Codex thread.
5. Ошибка адаптера не должна завершать или портить другую сессию.

## 6. Целевая архитектура

```text
sessions service
    │ AgentRun request
    ▼
agentExecutor.ts
    ├── claude-code adapter ── отдельный CLI process (без изменений)
    └── codex app-server adapter
             │
             ▼
       CodexAppServerManager (один на daemon)
         ├── JSON-RPC transport over stdio
         ├── pending requests: requestId → promise
         ├── sessions: Peon sessionId → ThreadBinding
         ├── turns: Codex turnId → TurnBinding
         ├── bounded outbound queue
         └── process supervision/restart
```

### 6.1 Новые компоненты

Предлагаемые файлы:

- `src/daemon/agents/codexAppServer/manager.ts` — singleton lifecycle и routing;
- `transport.ts` — spawn, JSONL framing, request/response correlation, backpressure;
- `protocol.ts` — минимальные runtime guards поверх generated types;
- `generated/` — version-matched TypeScript schemas, обновляемые скриптом;
- `eventNormalizer.ts` — app-server items → `AgentEvent`;
- `fileChangeNormalizer.ts` — per-item patch fragments → canonical unified diffs;
- `limits.ts` — централизованные caps;
- `__tests__/fixtures/` — записанные обезличенные protocol traces.

`runCodex()` должен стать тонким клиентом manager и по-прежнему возвращать `AgentRun`, чтобы `sessions service` не переписывался одновременно с transport layer.

### 6.2 Состояние manager

```ts
interface ThreadBinding {
  peonSessionId: string;
  threadId: string;
  cwd: string;
  activeTurnId: string | null;
  subscriberCount: number;
}

interface TurnBinding {
  peonSessionId: string;
  threadId: string;
  turnId: string;
  emitter: EventEmitter;
  status: "starting" | "running" | "interrupting" | "completed";
  pendingFileChanges: Map<string, PendingFileChange>;
  timeoutHandle: NodeJS.Timeout | null;
}
```

Manager не хранит transcript. После нормализации событие немедленно передаётся существующему `sessions service`, который остаётся единственным владельцем persistence и SSE.

## 7. Lifecycle

### 7.1 Запуск daemon

1. Лениво стартовать app-server при первой Codex-сессии либо eagerly после `restoreFromDisk`; решение конфигурируемое, default — lazy.
2. Spawn: `<codexCommand> app-server --listen stdio://`.
3. Отправить `initialize` с `clientInfo.name = "peon"`, title/version.
4. После успешного response отправить `initialized`.
5. Запросить/проверить требуемые capabilities только если они стабильны в сгенерированной schema.
6. Не принимать `thread/start` до завершения handshake.

### 7.2 Новая сессия

1. `thread/start` с cwd, model, approval/sandbox policy и provider config.
2. Сохранить возвращённый thread id в `SessionRecord.backendSessionId` до `turn/start`.
3. `turn/start` с пользовательским input, attachments, developer/system instructions и output schema.
4. Зарегистрировать `turnId → TurnBinding` до обработки последующих notifications.

### 7.3 Follow-up завершённой сессии

1. Если thread не loaded, вызвать `thread/resume` по `backendSessionId`.
2. Запустить новый `turn/start`.
3. Не создавать новый thread и не дублировать историю в prompt.

### 7.4 Сообщение во время активного turn

Первый rollout должен сохранять текущую семантику «последнее сообщение прерывает текущую работу»:

1. `turn/interrupt` активного turn.
2. Дождаться `turn/completed(status="interrupted")` с bounded timeout.
3. Запустить новый `turn/start` в том же thread.
4. Второй одновременный resume возвращает существующий `RESUME_IN_PROGRESS`.

После стабилизации можно отдельно рассмотреть `turn/steer`. Нельзя молча заменить interrupt+new turn на steer: это меняет transcript, outcome и ожидания пользователя.

### 7.5 Cancel и timeout

- `AgentRun.kill()` для app-server не убивает общий процесс; он вызывает `turn/interrupt` только для собственного turn.
- `sessions.cancel(id)` сохраняет текущую семантику outcome «Cancelled by user».
- Timeout вызывает `turn/interrupt`, ждёт terminal notification и локально финализирует turn при истечении grace period.
- Нельзя посылать SIGTERM app-server для отмены одной сессии.

### 7.6 Завершение и shutdown

- `turn/completed` является terminal event соответствующего `AgentRun`.
- После terminal event удалить `TurnBinding`, diff buffers и pending approvals.
- При SIGTERM прекратить принимать новые turns, interrupt активные turns с общим deadline, пометить оставшиеся interrupted существующим механизмом и завершить app-server.
- Thread не архивируется автоматически после turn: он нужен для follow-up.

## 8. Event routing и нормализация

Каждая notification маршрутизируется сначала по `turnId`, затем проверяется `threadId`. Несовпадение thread/turn — protocol error, событие не попадает в чужой transcript.

Минимальное отображение:

| App-server | Canonical Peon event |
|---|---|
| `thread/started` / response `thread/start` | `system/init` с `session_id=threadId` |
| agent message completed | `assistant/text` |
| command item started/completed | `assistant/tool_use` + `user/tool_result` |
| fileChange item completed | один `assistant/Edit` на каждый файл |
| MCP tool item | `assistant/tool_use` + `user/tool_result` |
| usage update / terminal turn | canonical `result` usage |
| `turn/completed` failed/interrupted | canonical error/cancel result |

Правила:

- Не сохранять raw provider event целиком.
- Не дублировать message из delta и completed item.
- Delta используется для live accumulation, canonical assistant event записывается один раз при надёжной границе завершения.
- Path внутри cwd сохраняется project-relative; внешний path остаётся absolute.
- Multi-file `fileChange` нормализуется в отдельные Edit events с одиночным `changes[]` и стабильными derived ids.
- Tool result должен ссылаться на derived id соответствующего Edit.

## 9. Точный per-edit diff

### 9.1 Требуемый результат

Каждый успешный Edit должен содержать unified diff только этого Edit:

```json
{
  "path": "src/example.ts",
  "kind": "update",
  "diff": "--- a/src/example.ts\n+++ b/src/example.ts\n@@ ...\n"
}
```

Diff фиксируется до публикации canonical Edit event и больше никогда не пересчитывается из worktree.

### 9.2 Source of truth

Для version floor `codex-cli >= 0.144.1` единственный источник — `changes[]` завершённого `ThreadItem` типа `fileChange`. Каждый элемент имеет форму:

```ts
type FileUpdateChange = {
  path: string;
  kind: { type: "add" | "delete" } | { type: "update"; move_path: string | null };
  diff: string;
};
```

`item/fileChange/patchUpdated` имеет тот же массив и дополнительно привязан к `itemId`, но в выполненном trace не потребовался: готовые changes присутствовали уже в `item/started` и `item/completed`. Canonical event публикуется по `item/completed`; `patchUpdated` можно использовать только для accumulation, если будущая версия начнёт отдавать частичные updates.

`turn/diff/updated` запрещено использовать для per-edit transcript: это cumulative diff turn. Оно может применяться только для optional UI «все изменения turn» и диагностики.

Если поддерживаемая будущая версия перестала отдавать per-item `diff`, adapter capability check должен отказать в старте или сохранить metadata с `diffUnavailable`; fallback на aggregate attribution не допускается без нового protocol spike.

Допустимые причины:

- `runtime_did_not_expose_patch`;
- `invalid_file_change_diff`;
- `unsupported_binary_change`;
- `app_server_restarted_before_item_completed`.

### 9.3 Нормализация runtime fragment

Runtime `FileUpdateChange.diff` является точным per-item fragment, но не всегда готовым стандартным unified diff:

- update содержит hunks (`@@ ...`) без `---`/`+++` headers;
- add/delete может содержать полное содержимое файла без hunk headers;
- rename кодируется как `kind.type="update"`, `move_path=<new path>` и может содержать только move metadata.

`fileChangeNormalizer` обязан детерминированно добавить headers и hunks, не читая worktree:

1. update: `--- a/<path>` / `+++ b/<path>` + runtime hunks;
2. add: `--- /dev/null` / `+++ b/<path>` + `@@ -0,0 +1,N @@` и строки с `+`;
3. delete: `--- a/<path>` / `+++ /dev/null` + `@@ -1,N +0,0 @@` и строки с `-`;
4. rename: `oldPath=path`, `path=move_path`; emit `similarity index 100%`, `rename from`, `rename to` для rename-only либо headers old/new + runtime hunks при одновременном content update.

Line counts и final-newline marker вычисляются только из runtime fragment. Если fragment не позволяет без потерь построить unified diff, сохраняется explicit `invalid_file_change_diff`, а не worktree reconstruction.

### 9.4 Добавление, удаление и rename

- add: `--- /dev/null`, `+++ b/<path>`;
- delete: `--- a/<path>`, `+++ /dev/null`;
- rename: `oldPath`, `path`, headers старого/нового path; rename-only допускает metadata lines и пустые hunks согласно runtime output;
- binary: не сохранять содержимое; использовать runtime binary patch только если он уже предоставлен и находится в поддерживаемом unified format, иначе explicit unavailable.

### 9.5 Whitespace и final newline

Diff generator/parser обязан работать с Buffer/UTF-8 без нормализации line endings и сохранять:

- пробелы и tabs;
- whitespace-only изменения;
- CRLF/LF distinction, если runtime diff её представляет;
- `\ No newline at end of file`;
- пустые файлы.

### 9.6 Лимиты

- максимум stored diff: 512 KiB на исходный tool invocation, даже если UI events разделены по файлам;
- максимум отдельной строки: 64 KiB;
- original byte count считается по UTF-8 bytes;
- truncation не должна ломать JSON и отмечается `diffTruncated`/`diffOriginalBytes`;
- `turn/diff/updated` не буферизуется и не сохраняется, если отдельный turn-level diff UI не включён;
- completed turn полностью освобождает pending per-item buffers.

## 10. Concurrency, очереди и backpressure

Сейчас Peon не имеет локального ceiling для интерактивных сессий. Перед включением общего app-server необходимо добавить admission control.

Defaults:

- `codexAppServerMaxActiveTurns = 6`;
- `codexAppServerMaxQueuedTurns = 100`;
- `codexAppServerRequestTimeoutMs = 30_000`;
- `codexAppServerInterruptGraceMs = 10_000`;
- stdout maximum unparsed line = 8 MiB;
- pending JSON-RPC requests = 256;
- per-turn pending fileChange queue = 128;
- per-turn pending fileChange bytes = 4 MiB.

Поведение:

- turns сверх active limit стоят в FIFO queue;
- cancel queued turn удаляет его без отправки в app-server;
- очередь не должна удерживать attachment contents в RAM — только paths/metadata;
- при заполнении queue API возвращает retryable `503 AGENT_CAPACITY_EXCEEDED`;
- write в stdin учитывает Node stream backpressure (`write() === false` → ждать `drain`);
- stdout parser ограничивает длину строки до JSON.parse;
- один медленный transcript/SSE consumer не блокирует чтение app-server stdout; persistence остаётся синхронной только в пределах существующей модели и отдельно профилируется.

## 11. Crash recovery и restart

### 11.1 Падение app-server

1. Отклонить все pending JSON-RPC promises общей typed error.
2. Завершить активные `AgentRun` как interrupted-by-runtime, не как model failure.
3. Очистить turn-local diff buffers.
4. Перезапустить app-server с exponential backoff и jitter: 250 ms, 500 ms, 1 s, 2 s, max 10 s.
5. Circuit breaker: не более 5 crash за 60 секунд; после этого adapter unhealthy до ручного/daemon restart.
6. Не делать автоматический replay неидемпотентного `turn/start`, если неизвестно, был ли запрос принят.

### 11.2 Восстановление threads

- `backendSessionId` уже persisted в summary и является ключом resume.
- После нового handshake manager не загружает тысячи threads в память.
- Thread загружается лениво через `thread/resume` только при follow-up или auto-resume.
- При unknown/missing thread Peon завершает follow-up понятной ошибкой; новый thread автоматически не создаётся, иначе история молча потеряется.

### 11.3 Daemon restart во время turn

Первый rollout сохраняет текущую политику Peon: активная сессия помечается interrupted, затем существующая ограниченная auto-resume логика может запустить новый turn в том же thread. Нельзя считать исходный turn завершённым успешно на основании частичного transcript.

После внедрения `thread/read` можно улучшить reconciliation: проверить terminal status последнего turn перед auto-resume, чтобы не повторить уже завершившуюся работу.

## 12. Security

- Использовать stdio, не открывать listener port.
- Не логировать полные JSON-RPC payloads: prompt, file contents, MCP headers и auth могут содержать секреты.
- Diagnostic logs содержат request id, method, thread/turn ids, размеры и duration, но не input/diff.
- MCP config и credentials продолжают создаваться с текущими file permissions.
- Paths нормализуются только для представления; security checks используют resolved absolute paths.
- Server-initiated requests обрабатываются allowlist-ом. Неизвестные requests получают method-not-supported, а не auto-approval.
- В unattended режиме approval/elicitation не зависает бесконечно: применить существующую policy либо reject с явной ошибкой.

## 13. Конфигурация и compatibility

Добавить настройки:

```ts
codexTransport: "exec" | "app-server";
codexAppServerMaxActiveTurns: number;
codexAppServerMaxQueuedTurns: number;
codexAppServerRequestTimeoutMs: number;
codexAppServerInterruptGraceMs: number;
```

Rollout default сначала `"exec"`. После прохождения acceptance и burn-in default меняется на `"app-server"`; `"exec"` остаётся аварийным fallback минимум один minor release.

`SessionRecord.agent` остаётся `"codex"`; transport — operational detail, а не новый provider. Опционально добавить `backendTransport` в новые records для диагностики и корректного resume во время rollout. Старые records без поля читаются как `exec`/auto согласно migration policy.

Публичные transcript endpoints и historical events остаются backward-compatible. Новые поля только additive.

## 14. Наблюдаемость

Добавить health snapshot без чувствительных данных:

- process state и uptime;
- protocol/schema version или Codex CLI version;
- active/queued turns;
- pending RPC count;
- restart count/circuit state;
- events received by method;
- orphan/unroutable event count;
- diff attribution: exact/unavailable/truncated/coalesced counts;
- p50/p95 request latency и turn queue wait;
- current buffered diff bytes.

Логи должны позволять ответить: «почему конкретный Edit не получил diff», не выводя сам diff.

## 15. Этапы реализации

### Этап 0 — protocol spike (выполнен для 0.144.1)

На фактически поддерживаемой версии Codex:

1. Сгенерировать TS/JSON schemas.
2. Записать raw traces для add/update/delete/rename, multi-file Edit, двух последовательных edits одного файла, shell edit между fileChange items, failed/partial edit, interrupt и two concurrent threads.
3. Проверить payload `fileChange`, порядок item/diff notifications и coalescing.
4. Проверить output schema, MCP config, attachments, permission mode и usage.
5. Сформулировать version floor.

Результат: **Go**. `fileChange.changes[]` содержит per-item diff напрямую. Aggregate revision не нужна. Минимальная версия первой реализации фиксируется как `0.144.1`; более старые версии должны отклоняться capability/version check либо использовать transport `exec`.

Дополнительно подтверждено:

- multi-file invocation — один item с отдельным change на файл;
- sequential edits — разные item ids и разные per-item fragments;
- failed apply_patch до изменения диска не создаёт completed successful fileChange;
- rename — `kind.update.move_path`;
- usage notification содержит `threadId`, `turnId`, total/last token breakdown;
- повторный `turn/start` активного thread runtime принимает, поэтому Peon обязан сам запрещать второй active turn per thread;
- `turn/interrupt` завершает turn статусом `interrupted`;
- persisted thread успешно `thread/resume` после остановки и нового запуска app-server.

### Этап 1 — transport и protocol

- process supervision;
- initialize handshake;
- request correlation/timeouts;
- generated types + runtime guards;
- bounded parser/write queue;
- unit tests на malformed messages, duplicate ids, early exit и backpressure.

### Этап 2 — thread/turn adapter

- start/resume;
- event routing;
- assistant/command/MCP/result normalization;
- cancel/timeout/interrupt;
- один и несколько concurrent threads.

### Этап 3 — diff tracker

- direct patch preservation;
- fragment-to-unified-diff normalizer;
- per-edit attribution;
- truncation/unavailable reasons;
- all requested filesystem cases, включая non-Git.

### Этап 4 — recovery и capacity

- admission queue;
- app-server crash/restart/circuit breaker;
- daemon shutdown;
- lazy thread resume;
- restart reconciliation.

### Этап 5 — shadow/beta rollout

- opt-in setting;
- internal sessions;
- metrics comparison with exec;
- canary percentage only if Peon has a stable per-session transport pin;
- documented rollback.

### Этап 6 — default switch

- app-server default;
- exec fallback retained;
- remove fallback only after separate decision and compatibility window.

## 16. Тест-план

### 16.1 Transport

- partial/multiple JSONL frames;
- invalid JSON and oversized line;
- out-of-order responses;
- server request vs notification vs response;
- request timeout and late response;
- stdin backpressure;
- process exit before/after initialize;
- restart storm/circuit breaker.

### 16.2 Session lifecycle

- new thread + turn;
- follow-up via thread/resume;
- concurrent turns in different threads;
- запрет двух active turns одного thread;
- interrupt+follow-up race;
- cancel одной сессии не влияет на другую;
- timeout;
- daemon restart and auto-resume;
- missing persisted thread;
- lazy loading тысяч сохранённых session summaries.

### 16.3 Transcript

- snapshot/SSE identity;
- stable ordering;
- no duplicate delta/completed messages;
- restart preserves recorded events;
- historical exec transcripts remain readable;
- path relative для Read/Write/Edit внутри cwd и absolute снаружи;
- multi-file call даёт отдельные Edit events.

### 16.4 Diff

- single replacement;
- multiple files;
- create/delete/rename;
- whitespace-only;
- final newline add/remove;
- CRLF where supported;
- sequential edits same path produce distinct diffs;
- later unrelated changes do not mutate earlier diff;
- non-Git cwd;
- oversized invocation and long line;
- failed no-op;
- partial success;
- malformed/missing per-item fragment;
- shell mutation of same file;
- binary file;
- app-server crash between item and diff update.

### 16.5 Load/soak

- 1, 6, 20 и 100 queued sessions;
- 6 active turns for at least one hour;
- repeated short follow-ups;
- large transcripts and diff events;
- RSS returns near baseline after turns complete;
- no growth in listeners, pending promises, buffers or loaded threads;
- one slow SSE client does not stall app-server routing.

## 17. Критерии приёмки

1. Один app-server обслуживает минимум 6 concurrent Codex turns в разных Peon-сессиях.
2. Cancel/timeout/failure одной сессии не завершает другие.
3. Follow-up продолжает тот же Codex thread после завершения и daemon restart.
4. Transcript/SSE canonical contract не меняется несовместимо.
5. Новый Edit содержит exact per-edit diff из собственного `fileChange` item.
6. Missing/malformed per-item diff никогда не заменяется aggregate turn diff; присутствует explicit reason.
7. Diff не зависит от Git и не пересчитывается из позднего worktree.
8. Лимиты diff, строк, очередей и buffers покрыты тестами.
9. После 1-hour soak нет монотонного роста RSS/pending maps/listeners.
10. Feature flag позволяет вернуть `codexTransport="exec"` одним restart без миграции transcript.
11. Typecheck, unit, integration и restart/resume suites проходят.
12. Protocol spike документирует поддерживаемую минимальную версию Codex и приложенные trace fixtures.

## 18. Риски и решения

| Риск | Последствие | Решение |
|---|---|---|
| Runtime уберёт per-item diff | Нельзя получить exact per-edit diff | Version floor + generated schema/capability check; не использовать aggregate fallback |
| App-server protocol меняется | Runtime breakage | Generated schema per supported version, version floor, capability guards |
| Общий процесс падает | Затронуты все Codex turns | Isolation in routing, restart supervisor, circuit breaker, no blind replay |
| Unlimited parallelism | OOM/overload | Active limit + bounded queue + admission error |
| Stateful resume race | Duplicate turns or lost prompt | Per-thread mutex/state machine, idempotency discipline |
| Slow stdout consumer | app-server stalls | Minimal synchronous work, bounded parsing, immediate routing |
| Большой per-item patch | Memory pressure | 4 MiB pending-item cap, per-invocation 512 KiB stored cap |
| Unknown server requests | Deadlock/security issue | Allowlist handlers, timeout and explicit rejection |
| Rollout mixes transports | Resume incompatibility | Persist transport pin or restrict switching to new sessions |

## 19. Ответы Stage 0 и принятые решения

1. **Per-item patch:** да. В 0.144.1 `FileUpdateChange` содержит `path`, structured `kind`, `diff`; runtime trace это подтвердил.
2. **Порядок aggregate diff:** в trace `turn/diff/updated` приходил после `item/completed`, иногда повторялся без изменений и был cumulative. Гарантия отдельного aggregate update не нужна и не используется.
3. **Revision marker:** у `turn/diff/updated` его нет. У per-item events есть `itemId`; correlation строится на `threadId + turnId + itemId`.
4. **Command changes в aggregate:** несущественно для transcript, потому что aggregate diff исключён из per-edit pipeline. Command event остаётся отдельным tool event.
5. **Rename/failure:** rename — `kind.update.move_path`; status — `inProgress | completed | failed | declined`. Failed patch до изменения диска в trace не дал successful completed fileChange. При failed item с changes сохраняются фактически сообщённые changes и partial/error semantics.
6. **Замена CLI flags:** `thread/start/resume` несут cwd, model, approvalPolicy, sandbox, generic config, base/developer instructions; `turn/start` несёт cwd, approvalPolicy, sandboxPolicy, model, effort и outputSchema. Images передаются `localImage`; остальные attachments сохраняют текущую prompt-path модель. MCP overrides передаются через thread `config`: schema предоставляет generic config tree, а официальная документация подтверждает, что required MCP server участвует в `thread/start/resume`. Exact conversion существующего `mcp-config.json` фиксируется integration fixture в реализации, но отдельного protocol blocker здесь нет.
7. **Usage/model:** `thread/tokenUsage/updated` привязан к thread/turn и содержит total/last input, cached input, output и reasoning tokens. Model берётся из `ThreadStartResponse`/`ThreadResumeResponse`; duration — из completed `Turn.durationMs`.
8. **Два turns одного thread:** runtime 0.144.1 принял второй `turn/start` во время активного первого. Peon вводит обязательный per-thread mutex и никогда не полагается на server rejection.
9. **Persistence:** non-ephemeral thread пережил остановку app-server и успешно возобновился по id новым процессом; missing thread остаётся явной ошибкой без silent recreation.
10. **Unsubscribe:** после terminal turn и при отсутствии немедленного follow-up Peon вызывает `thread/unsubscribe`, чтобы app-server мог выгрузить thread после grace period. Следующий follow-up делает `thread/resume`. При удалении Peon-сессии дополнительно решается archive/delete policy; unsubscribe не удаляет persisted history.

## 20. Definition of Done

Переход считается завершённым только после default switch и burn-in. Наличие работающего JSON-RPC клиента без recovery, limits, protocol fixtures и доказанной diff attribution не считается завершённой миграцией.
