import type { Locale } from "./i18n";

// One timestamp vocabulary for the whole app: today is just the clock, yesterday
// is named, anything older gets a short day+month. Chat bubbles and the session
// sidebar must read the same way, so both call this. author: Viktor

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function localeTag(locale: Locale): string {
  return locale === "ru" ? "ru-RU" : "en-GB";
}

export function formatLocalTimestamp(at: number, now: number, locale: Locale, yesterdayLabel: string): string {
  if (!at) return "";
  const date = new Date(at);
  const current = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return "";
  const tag = localeTag(locale);
  const time = new Intl.DateTimeFormat(tag, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  if (sameLocalDay(date, current)) return time;
  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return `${yesterdayLabel.toLowerCase()}, ${time}`;
  const dayAndMonth = new Intl.DateTimeFormat(tag, {
    day: "numeric",
    month: "short",
  }).format(date).replace(/\.$/, "").toLowerCase();
  return `${dayAndMonth}, ${time}`;
}
