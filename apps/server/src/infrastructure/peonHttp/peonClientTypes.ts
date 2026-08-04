import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

export interface PeonConn {
  baseUrl: string;
  token: string;
}

export interface PeonCallResult {
  status: number;
  ok: boolean;
  json: unknown;
  requestId?: string;
}

export interface ProxyErrorResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface PeonCallOptions {
  actor?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  requestId?: string;
}

export interface PeonNetworkError {
  error: string;
  code: string;
}

export type PeonToChunksCb = (text: string) => void;
export type PeonProxyResult = Promise<void>;

export interface ProxyStreamRequestOptions {
  actor?: string | null;
}

export interface ProxyStreamToOptions {
  actor?: string | null;
  lastEventId?: string | null;
}

export interface FileSegmentsProxyOptions {
  actor?: string | null;
}

export type ExpressRequestLike = ExpressRequest;
export type ExpressResponseLike = ExpressResponse;
