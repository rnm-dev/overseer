import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Lightweight, dependency-free i18n. A locale is a flat key->string catalog;
// {var} placeholders are interpolated. Locale is persisted to localStorage and
// falls back to the browser language, then English. Add a language by dropping
// another catalog into `catalogs` + `LOCALES`.
// author: Viktor

export type Locale = "en" | "ru";

type Catalog = Record<string, string>;

const en: Catalog = {
  "app.name": "Overseer",
  "app.tagline": "Peon control plane",
  "app.loading": "Loading…",

  "action.signOut": "Sign out",
  "action.remove": "remove",
  "a11y.close": "close",

  "login.github": "Sign in with GitHub",
  "login.signingIn": "redirecting to GitHub…",
  "login.callback": "Completing sign-in…",
  "login.callbackFailed": "Sign-in failed. Please try again.",
  "login.backToLogin": "back to sign in",

  "nav.new": "+ new",
  "nav.dashboard": "Dashboard",
  "nav.newWorkspace": "+ New workspace",

  "stat.peonsOnline": "Peons online",
  "stat.activeSessions": "Active sessions",
  "stat.needsAttention": "Needs attention",
  "stat.members": "Members",

  "section.peons": "Peons",
  "peons.connect": "+ Connect peon",
  "peons.empty": "No peons in this workspace. Connect one to get started.",
  "peons.unnamed": "unnamed peon",
  "peons.online": "online",
  "peons.offline": "offline",
  "peons.active": "{n} active",

  "peon.back": "← Back",
  "peon.notFound": "Peon not found.",
  "peon.offlineNote": "This peon is offline — live data is unavailable.",
  "peon.unsupported": "This peon doesn’t support this yet.",
  "peon.tab.dashboard": "Overview",
  "peon.tab.sessions": "Sessions",
  "peon.tab.projects": "Projects",
  "peon.tab.settings": "Settings",
  "peon.stat.activeSessions": "Active sessions",
  "peon.stat.uptime": "Uptime",
  "peon.stat.state": "State",
  "peon.state.running": "Running",
  "peon.state.paused": "Paused",
  "peon.capabilities": "Capabilities",
  "peon.pause": "Pause",
  "peon.resume": "Resume",
  "peon.projects.empty": "No projects on this peon yet.",
  "newProject.new": "+ New project",
  "newProject.title": "New project",
  "newProject.manual": "Manual",
  "newProject.import": "Import",
  "newProject.label": "Label",
  "newProject.dir": "Directory",
  "newProject.info": "Description (optional)",
  "newProject.create": "Create",
  "newProject.creating": "Creating…",
  "newProject.integration": "Integration",
  "newProject.imported": "imported",
  "newProject.importBtn": "Import",
  "newProject.noIntegrations": "No connected integrations.",
  "newProject.noCatalog": "No importable projects.",
  "newProject.exists": "A project with that key already exists.",

  "proj.back": "← Projects",
  "proj.setup": "Run setup",
  "proj.reSetup": "Re-run setup",
  "proj.settingUp": "Starting setup…",
  "proj.verify": "Verify",
  "proj.verifying": "Starting verify…",
  "proj.setupFirst": "Run setup first.",
  "proj.files.root": "root",
  "proj.files.empty": "Empty folder.",
  "proj.files.pick": "Select a file to view.",
  "proj.files.tooLarge": "File too large to preview ({size}).",
  "peon.projects.sessions": "{n} sessions",
  "peon.projects.active": "{n} active",
  "peon.settings.name": "Name",
  "peon.settings.fileRoot": "File transfer root",
  "peon.settings.heartbeat": "Heartbeat (ms)",
  "peon.settings.save": "Save changes",
  "peon.settings.saving": "saving…",
  "peon.settings.saved": "Saved",
  "peon.settings.danger": "Danger zone",
  "peon.settings.delete": "Delete peon",
  "peon.settings.deleteHint": "Removes this peon from the workspace and revokes its credential.",
  "peon.settings.deleteConfirm": "Delete this peon? This revokes its credential and can’t be undone.",
  "peon.settings.deleting": "deleting…",
  "peon.tab.stats": "Stats",
  "peon.auth.label": "Agent CLI",
  "peon.auth.ok": "Ready",
  "peon.auth.unauthenticated": "Not signed in",
  "peon.auth.broken": "Broken",
  "peon.auth.unknown": "Unknown",
  "peon.auth.warnUnauth": "The Claude CLI is not signed in on this peon — new sessions will be refused until it's authenticated.",
  "peon.auth.warnBroken": "The Claude CLI is broken on this peon — new sessions will be refused until it's fixed.",
  "peon.stats.period.day": "Today",
  "peon.stats.period.yesterday": "Yesterday",
  "peon.stats.period.week": "Week",
  "peon.stats.period.month": "Month",
  "peon.stats.sessions": "Sessions",
  "peon.stats.tokens": "Tokens",
  "peon.stats.cost": "Cost",
  "peon.stats.duration": "Duration",
  "peon.stats.outcomes": "Outcomes",
  "peon.stats.empty": "No activity in this period.",
  "peon.stats.inputTokens": "Input",
  "peon.stats.outputTokens": "Output",
  "peon.stats.cacheRead": "Cache read",
  "peon.stats.cacheWrite": "Cache write",
  "peon.stats.missingUsage": "{n} run(s) missing usage data — cost may undercount.",

  "peon.conn.title": "Connectivity",
  "peon.conn.hint": "How the overseer reaches this peon. Edit if it's unreachable or mis-addressed — your value is pinned and won't be overwritten when the peon reconnects.",
  "peon.conn.address": "Address",
  "peon.conn.port": "Control port",
  "peon.conn.reaches": "Overseer calls",
  "peon.conn.pinned": "pinned",

  "peon.dash.recentSessions": "Recent sessions",
  "peon.dash.projects": "Projects",
  "peon.dash.viewAll": "View all →",
  "peon.dash.noSessions": "No sessions yet.",

  "session.menu": "More",
  "session.rename": "rename",
  "session.rename.save": "Save",
  "session.renamePlaceholder": "Session title",
  "session.untitled": "Untitled session",
  "session.project": "Project",
  "session.events": "{n} events",
  "session.delete": "delete",
  "session.delete.confirm": "Delete this session?",
  "session.delete.confirmYes": "Delete",
  "session.delete.deleting": "deleting…",
  "session.delete.running": "Cancel the session before deleting it.",
  "session.stop": "stop",
  "session.stop.stopping": "stopping…",
  "session.stop.nothing": "Nothing is running to stop.",
  "session.chat.thinking": "Thinking",
  "session.chat.ended": "Session ended",
  "session.chat.failed": "Session failed",
  "session.chat.turns": "{n} turns",
  "session.chat.more": "show more",
  "session.chat.less": "show less",
  "session.working.thinking": "Agent is thinking…",
  "session.working.typing": "Agent is writing…",
  "session.working.bash": "Running a command…",
  "session.working.read": "Reading a file…",
  "session.working.edit": "Editing files…",
  "session.working.search": "Searching the code…",
  "session.working.web": "Searching the web…",
  "session.working.subagent": "Running a sub-agent…",
  "session.working.tool": "Working: {name}…",
  "model.default": "Default",
  "model.peonDefault": "Peon default ({name})",
  "newSession.model": "Model",
  "session.model": "Model",
  "session.compose.model": "Model for this turn",
  "session.usage.by": "Usage by model",
  "peon.stats.byModel": "By model",
  "peon.stats.byModel.sessions": "{n} sessions",
  "peon.settings.aiDefaultModel": "Default model",
  "peon.settings.aiDefaultModelHint": "Used by new sessions and existing ones with no model explicitly chosen.",
  "session.compose.placeholder": "Message…  (Enter to send, Shift+Enter for newline)",
  "session.compose.send": "Send",
  "session.compose.sending": "Sending…",
  "session.compose.attach": "Attach files",
  "session.compose.preview": "Click to preview",
  "session.compose.busy": "Session is busy — resend in a moment.",
  "session.compose.filesDisabled": "File transfer is off on this peon",
  "session.compose.filesDisabledHint": "File transfer is off — enable it in the peon's Settings tab to attach files.",
  "session.compose.settingsLink": "Open Settings",
  "session.compose.tooLarge": "Files must be ≤ 25 MB each.",
  "session.compose.tooMany": "Up to 10 files per message.",
  "session.compose.badType": "Unsupported image type (png/jpeg/gif/webp).",
  "session.compose.uploadFailed": "Attachment upload failed — try again.",

  "live.on": "Live",
  "live.reconnecting": "Reconnecting…",
  "session.back": "← Sessions",
  "session.empty": "No transcript yet.",
  "session.tail.live": "streaming",
  "session.tail.ended": "stream ended",
  "session.tail.error": "stream unavailable",

  "section.sessions": "Sessions",
  "sessions.empty": "No sessions across this workspace's peons.",
  "newSession.new": "+ New session",
  "newSession.title": "New session",
  "newSession.project": "Project",
  "newSession.prompt": "Prompt",
  "newSession.promptPlaceholder": "What should the agent do?",
  "newSession.start": "Start",
  "newSession.starting": "Starting…",
  "newSession.agentUnavailable": "This peon's agent CLI isn't ready — sessions can't start until it's signed in.",
  "status.unknown": "unknown",

  "section.members": "Members",
  "role.owner": "owner",
  "role.member": "member",

  "invites.title": "Invite links",
  "invites.new": "+ new link",
  "invites.empty": "No active invite links.",
  "invites.copy": "copy",
  "invites.copied": "copied!",
  "invites.share": "share",
  "invites.revoke": "revoke",
  "invites.expires": "expires {date}",
  "invites.shareTitle": "Join my Overseer workspace",

  "join.invited": "You've been invited to join",
  "join.signIn": "Sign in with GitHub to join",
  "join.joining": "Joining {workspace}…",
  "join.invalid": "This invite link is invalid or has expired.",
  "join.backHome": "go to Overseer",

  "addPeon.title": "Connect a peon",
  "addPeon.url": "Peon URL",
  "addPeon.secret": "Secret phrase",
  "addPeon.secretHelp": "Set on the peon itself. Overseer verifies it before connecting.",
  "addPeon.connected": "Connected. Ready to add.",
  "addPeon.connectedNamed": "Connected to “{name}”. Ready to add.",
  "addPeon.check": "Check",
  "addPeon.checking": "checking…",
  "addPeon.add": "Add peon",
  "addPeon.adding": "adding…",

  "newWs.title": "New workspace",
  "newWs.name": "Workspace name",
  "newWs.placeholder": "e.g. My peons",
  "newWs.hint": "A workspace is an isolated group — its own peons and members.",
  "newWs.create": "Create",
  "newWs.creating": "creating…",
  "newWs.failed": "Couldn’t create the workspace.",
  "action.cancel": "Cancel",

  "prompt.workspaceName": "Workspace name?",
  "prompt.inviteEmail": "Invite by email:",

  "error.generic": "something went wrong",
  "error.wrongCode": "wrong or expired code",
  "error.verifyFailed": "verification failed",
  "error.loadFailed": "load failed",
  "error.inviteFailed": "invite failed",
  "error.joinFailed": "couldn't join workspace",
  "error.connectionFailed": "connection failed",
  "error.couldntAdd": "couldn't add peon",
};

const ru: Catalog = {
  "app.name": "Overseer",
  "app.tagline": "Панель управления Peon",
  "app.loading": "Загрузка…",

  "action.signOut": "Выйти",
  "action.remove": "удалить",
  "a11y.close": "закрыть",

  "login.github": "Войти через GitHub",
  "login.signingIn": "переход на GitHub…",
  "login.callback": "Завершаем вход…",
  "login.callbackFailed": "Не удалось войти. Попробуйте ещё раз.",
  "login.backToLogin": "назад ко входу",

  "nav.new": "+ новый",
  "nav.dashboard": "Дашборд",
  "nav.newWorkspace": "+ Новое пространство",

  "stat.peonsOnline": "Peons онлайн",
  "stat.activeSessions": "Активные сессии",
  "stat.needsAttention": "Требует внимания",
  "stat.members": "Участники",

  "section.peons": "Peons",
  "peons.connect": "+ Подключить peon",
  "peons.empty": "В этом пространстве нет peon. Подключите, чтобы начать.",
  "peons.unnamed": "без имени",
  "peons.online": "онлайн",
  "peons.offline": "офлайн",
  "peons.active": "{n} активн.",

  "peon.back": "← Назад",
  "peon.notFound": "Peon не найден.",
  "peon.offlineNote": "Peon офлайн — актуальные данные недоступны.",
  "peon.unsupported": "Этот peon пока не поддерживает это.",
  "peon.tab.dashboard": "Обзор",
  "peon.tab.sessions": "Сессии",
  "peon.tab.projects": "Проекты",
  "peon.tab.settings": "Настройки",
  "peon.stat.activeSessions": "Активные сессии",
  "peon.stat.uptime": "Аптайм",
  "peon.stat.state": "Состояние",
  "peon.state.running": "Работает",
  "peon.state.paused": "Пауза",
  "peon.capabilities": "Возможности",
  "peon.pause": "Пауза",
  "peon.resume": "Возобновить",
  "peon.projects.empty": "На этом peon пока нет проектов.",
  "newProject.new": "+ Новый проект",
  "newProject.title": "Новый проект",
  "newProject.manual": "Вручную",
  "newProject.import": "Импорт",
  "newProject.label": "Название",
  "newProject.dir": "Директория",
  "newProject.info": "Описание (необязательно)",
  "newProject.create": "Создать",
  "newProject.creating": "Создание…",
  "newProject.integration": "Интеграция",
  "newProject.imported": "импортирован",
  "newProject.importBtn": "Импортировать",
  "newProject.noIntegrations": "Нет подключённых интеграций.",
  "newProject.noCatalog": "Нет проектов для импорта.",
  "newProject.exists": "Проект с таким ключом уже существует.",

  "proj.back": "← Проекты",
  "proj.setup": "Запустить настройку",
  "proj.reSetup": "Перезапустить настройку",
  "proj.settingUp": "Запуск настройки…",
  "proj.verify": "Проверить",
  "proj.verifying": "Запуск проверки…",
  "proj.setupFirst": "Сначала запустите настройку.",
  "proj.files.root": "корень",
  "proj.files.empty": "Пустая папка.",
  "proj.files.pick": "Выберите файл для просмотра.",
  "proj.files.tooLarge": "Файл слишком большой для просмотра ({size}).",
  "peon.projects.sessions": "{n} сессий",
  "peon.projects.active": "{n} активн.",
  "peon.settings.name": "Имя",
  "peon.settings.fileRoot": "Корень передачи файлов",
  "peon.settings.heartbeat": "Heartbeat (мс)",
  "peon.settings.save": "Сохранить",
  "peon.settings.saving": "сохранение…",
  "peon.settings.saved": "Сохранено",
  "peon.settings.danger": "Опасная зона",
  "peon.settings.delete": "Удалить peon",
  "peon.settings.deleteHint": "Убирает peon из пространства и отзывает его учётные данные.",
  "peon.settings.deleteConfirm": "Удалить этот peon? Учётные данные будут отозваны, отменить нельзя.",
  "peon.settings.deleting": "удаление…",
  "peon.tab.stats": "Статистика",
  "peon.auth.label": "Агент CLI",
  "peon.auth.ok": "Готов",
  "peon.auth.unauthenticated": "Не авторизован",
  "peon.auth.broken": "Не работает",
  "peon.auth.unknown": "Неизвестно",
  "peon.auth.warnUnauth": "Claude CLI на этом peon не авторизован — новые сессии будут отклонены, пока он не войдёт в систему.",
  "peon.auth.warnBroken": "Claude CLI на этом peon не работает — новые сессии будут отклонены, пока он не будет исправлен.",
  "peon.stats.period.day": "Сегодня",
  "peon.stats.period.yesterday": "Вчера",
  "peon.stats.period.week": "Неделя",
  "peon.stats.period.month": "Месяц",
  "peon.stats.sessions": "Сессии",
  "peon.stats.tokens": "Токены",
  "peon.stats.cost": "Стоимость",
  "peon.stats.duration": "Длительность",
  "peon.stats.outcomes": "Итоги",
  "peon.stats.empty": "Нет активности за этот период.",
  "peon.stats.inputTokens": "Вход",
  "peon.stats.outputTokens": "Выход",
  "peon.stats.cacheRead": "Чтение кэша",
  "peon.stats.cacheWrite": "Запись кэша",
  "peon.stats.missingUsage": "У {n} запуск(ов) нет данных об использовании — стоимость может быть занижена.",

  "peon.conn.title": "Подключение",
  "peon.conn.hint": "Как overseer связывается с этим peon. Измените, если он недоступен или указан неверный адрес — ваше значение закреплено и не будет перезаписано при повторном подключении peon.",
  "peon.conn.address": "Адрес",
  "peon.conn.port": "Порт управления",
  "peon.conn.reaches": "Overseer вызывает",
  "peon.conn.pinned": "закреплено",

  "peon.dash.recentSessions": "Недавние сессии",
  "peon.dash.projects": "Проекты",
  "peon.dash.viewAll": "Все →",
  "peon.dash.noSessions": "Пока нет сессий.",

  "session.menu": "Ещё",
  "session.rename": "переименовать",
  "session.rename.save": "Сохранить",
  "session.renamePlaceholder": "Название сессии",
  "session.untitled": "Сессия без названия",
  "session.project": "Проект",
  "session.events": "событий: {n}",
  "session.delete": "удалить",
  "session.delete.confirm": "Удалить эту сессию?",
  "session.delete.confirmYes": "Удалить",
  "session.delete.deleting": "удаление…",
  "session.delete.running": "Отмените сессию перед удалением.",
  "session.stop": "остановить",
  "session.stop.stopping": "остановка…",
  "session.stop.nothing": "Нечего останавливать.",
  "session.chat.thinking": "Размышление",
  "session.chat.ended": "Сессия завершена",
  "session.chat.failed": "Сессия завершилась с ошибкой",
  "session.chat.turns": "ходов: {n}",
  "session.chat.more": "показать больше",
  "session.chat.less": "свернуть",
  "session.working.thinking": "Агент думает…",
  "session.working.typing": "Агент печатает…",
  "session.working.bash": "Выполняет команду…",
  "session.working.read": "Читает файл…",
  "session.working.edit": "Редактирует файлы…",
  "session.working.search": "Ищет по коду…",
  "session.working.web": "Ищет в вебе…",
  "session.working.subagent": "Запускает под-агента…",
  "session.working.tool": "Работает: {name}…",
  "model.default": "По умолчанию",
  "model.peonDefault": "Дефолт пеона ({name})",
  "newSession.model": "Модель",
  "session.model": "Модель",
  "session.compose.model": "Модель на этот ход",
  "session.usage.by": "Расход по моделям",
  "peon.stats.byModel": "По моделям",
  "peon.stats.byModel.sessions": "сессий: {n}",
  "peon.settings.aiDefaultModel": "Модель по умолчанию",
  "peon.settings.aiDefaultModelHint": "Применяется к новым сессиям и существующим без явно выбранной модели.",
  "session.compose.placeholder": "Сообщение…  (Enter — отправить, Shift+Enter — новая строка)",
  "session.compose.send": "Отправить",
  "session.compose.sending": "Отправка…",
  "session.compose.attach": "Прикрепить файлы",
  "session.compose.preview": "Нажмите для просмотра",
  "session.compose.busy": "Сессия занята — повторите через мгновение.",
  "session.compose.filesDisabled": "Передача файлов отключена на этом peon",
  "session.compose.filesDisabledHint": "Передача файлов отключена — включите её на вкладке «Настройки» peon, чтобы прикреплять файлы.",
  "session.compose.settingsLink": "Открыть настройки",
  "session.compose.tooLarge": "Каждый файл — не больше 25 МБ.",
  "session.compose.tooMany": "До 10 файлов на сообщение.",
  "session.compose.badType": "Неподдерживаемый тип изображения (png/jpeg/gif/webp).",
  "session.compose.uploadFailed": "Не удалось загрузить вложение — попробуйте снова.",

  "live.on": "В эфире",
  "live.reconnecting": "Переподключение…",
  "session.back": "← Сессии",
  "session.empty": "Пока нет транскрипта.",
  "session.tail.live": "поток",
  "session.tail.ended": "поток завершён",
  "session.tail.error": "поток недоступен",

  "section.sessions": "Сессии",
  "sessions.empty": "Нет сессий на peon этого пространства.",
  "newSession.new": "+ Новая сессия",
  "newSession.title": "Новая сессия",
  "newSession.project": "Проект",
  "newSession.prompt": "Запрос",
  "newSession.promptPlaceholder": "Что должен сделать агент?",
  "newSession.start": "Запустить",
  "newSession.starting": "Запуск…",
  "newSession.agentUnavailable": "Агент CLI на этом peon не готов — сессии нельзя запустить, пока он не войдёт в систему.",
  "status.unknown": "неизвестно",

  "section.members": "Участники",
  "role.owner": "владелец",
  "role.member": "участник",

  "invites.title": "Ссылки-приглашения",
  "invites.new": "+ новая ссылка",
  "invites.empty": "Нет активных ссылок-приглашений.",
  "invites.copy": "копировать",
  "invites.copied": "скопировано!",
  "invites.share": "поделиться",
  "invites.revoke": "отозвать",
  "invites.expires": "истекает {date}",
  "invites.shareTitle": "Присоединяйтесь к моему пространству Overseer",

  "join.invited": "Вас пригласили присоединиться к",
  "join.signIn": "Войдите через GitHub, чтобы присоединиться",
  "join.joining": "Присоединение к {workspace}…",
  "join.invalid": "Эта ссылка-приглашение недействительна или истекла.",
  "join.backHome": "перейти в Overseer",

  "addPeon.title": "Подключить peon",
  "addPeon.url": "URL peon",
  "addPeon.secret": "Секретная фраза",
  "addPeon.secretHelp": "Задаётся на самом peon. Overseer проверит её перед подключением.",
  "addPeon.connected": "Подключено. Можно добавить.",
  "addPeon.connectedNamed": "Подключено к «{name}». Можно добавить.",
  "addPeon.check": "Проверить",
  "addPeon.checking": "проверка…",
  "addPeon.add": "Добавить peon",
  "addPeon.adding": "добавление…",

  "newWs.title": "Новое пространство",
  "newWs.name": "Название пространства",
  "newWs.placeholder": "напр. Мои peon-ы",
  "newWs.hint": "Пространство — изолированная группа со своими peon-ами и участниками.",
  "newWs.create": "Создать",
  "newWs.creating": "создание…",
  "newWs.failed": "Не удалось создать пространство.",
  "action.cancel": "Отмена",

  "prompt.workspaceName": "Название пространства?",
  "prompt.inviteEmail": "Пригласить по эл. почте:",

  "error.generic": "что-то пошло не так",
  "error.wrongCode": "неверный или просроченный код",
  "error.verifyFailed": "не удалось подтвердить",
  "error.loadFailed": "не удалось загрузить",
  "error.inviteFailed": "не удалось пригласить",
  "error.joinFailed": "не удалось присоединиться",
  "error.connectionFailed": "не удалось подключиться",
  "error.couldntAdd": "не удалось добавить peon",
};

const catalogs: Record<Locale, Catalog> = { en, ru };

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "ru", label: "RU" },
];

const STORAGE_KEY = "overseer.locale";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    /* localStorage unavailable */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language?.slice(0, 2) : "en";
  return nav === "ru" ? "ru" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function useT(): Translate {
  return useI18n().t;
}
