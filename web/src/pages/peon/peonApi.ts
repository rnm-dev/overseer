import { api } from "../../api";

export type ApiRequest = <T = unknown>(path: string, options?: RequestInit) => Promise<T>;

export interface ProjectDetail {
  projectId?: string | null;
  key?: string;
  label?: string;
  scope?: string | null;
  dir?: string;
  metadata: string | null;
  quickLinks?: ProjectQuickLink[];
}

export interface ProjectQuickLink {
  id: string;
  title: string;
  url: string;
  order: number;
}

export interface ProjectQuickLinksResponse {
  links: ProjectQuickLink[];
  cache?: { state?: string; stale?: boolean; updatedAt?: number | null };
}

export interface CreateProjectInput {
  label: string;
  dir?: string;
  metadata?: string | null;
}

export interface ProjectSettings {
  key: string;
  name: string;
  dir: string;
  metadata: string | null;
  quickLinks?: ProjectQuickLink[];
}

export interface UpdateProjectSettingsInput {
  key: string;
  name: string;
  dir: string;
  metadata: string | null;
}

export interface ProjectSkill {
  name: string;
  description: string;
  path?: string | null;
}

export interface ProjectSkillsResponse {
  skills: ProjectSkill[];
}

interface PeonSoulSettings {
  soul?: unknown;
}

export async function getPeonSoul(base: string, request: ApiRequest = api): Promise<string | null> {
  const settings = await request<PeonSoulSettings>(`${base}/settings`);
  return typeof settings.soul === "string" && settings.soul !== "" ? settings.soul : null;
}

export async function savePeonSoul(base: string, soul: string, request: ApiRequest = api): Promise<string | null> {
  const settings = await request<PeonSoulSettings>(`${base}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ soul }),
  });
  return typeof settings.soul === "string" && settings.soul !== "" ? settings.soul : null;
}

export function soulExcerpt(markdown: string, maxLength = 180): string {
  const plain = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function projectMetadataValue(value: string): string | null {
  return value === "" ? null : value;
}

export function projectRoute(peonId: string, key: string): string {
  return `/peons/${encodeURIComponent(peonId)}/projects/${encodeURIComponent(key)}`;
}

export function createProject(base: string, input: CreateProjectInput, request: ApiRequest = api) {
  return request<ProjectDetail>(`${base}/projects`, { method: "POST", body: JSON.stringify(input) });
}

export function getProjectSettings(base: string, key: string, request: ApiRequest = api) {
  return request<ProjectSettings>(`${base}/projects/${encodeURIComponent(key)}/settings`);
}

export function updateProjectSettings(base: string, key: string, input: UpdateProjectSettingsInput, request: ApiRequest = api) {
  return request<ProjectSettings>(`${base}/projects/${encodeURIComponent(key)}/settings`, { method: "PATCH", body: JSON.stringify(input) });
}

export function getProjectQuickLinks(base: string, key: string, request: ApiRequest = api) {
  return request<ProjectQuickLinksResponse>(`${base}/projects/${encodeURIComponent(key)}/quick-links`);
}

export function createProjectQuickLink(base: string, key: string, input: { title: string; url: string }, request: ApiRequest = api) {
  return request<ProjectQuickLink>(`${base}/projects/${encodeURIComponent(key)}/quick-links`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProjectQuickLink(base: string, key: string, id: string, input: { title: string; url: string }, request: ApiRequest = api) {
  return request<ProjectQuickLink>(`${base}/projects/${encodeURIComponent(key)}/quick-links/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteProjectQuickLink(base: string, key: string, id: string, request: ApiRequest = api) {
  return request<{ ok: true }>(`${base}/projects/${encodeURIComponent(key)}/quick-links/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getProjectSkills(base: string, key: string, request: ApiRequest = api) {
  return request<ProjectSkillsResponse>(`${base}/projects/${encodeURIComponent(key)}/skills`, { cache: "no-store" });
}

export function setPeonPaused(base: string, paused: boolean, request: ApiRequest = api) {
  return request(`${base}/status`, { method: "PATCH", body: JSON.stringify({ paused }) });
}
