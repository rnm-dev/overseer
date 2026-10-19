import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";

// A monotonically increasing scope token lets a caller ignore a response that
// was started for a previous path, query, cursor chain, or Peon.
export interface RequestScope {
  begin(): number;
  current(token: number): boolean;
  clear(): void;
}

export function createRequestScope(): RequestScope {
  let generation = 0;
  return {
    begin: () => ++generation,
    current: (token) => token === generation,
    clear: () => { generation += 1; },
  };
}

export function useRequestScope(): RequestScope {
  const ref = useRef<RequestScope | null>(null);
  ref.current ??= createRequestScope();
  return ref.current;
}

export interface ApiResource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | null>>;
}

interface ResourceState<T> { path: string | null; data: T | null; error: unknown; loading: boolean }

// Pure transitions, exported for tests. A new path discards the previous
// path's data and error; a reload of the same path keeps them until it settles.
export function resourceStarted<T>(state: ResourceState<T>, path: string | null): ResourceState<T> {
  if (path === null) return { path, data: null, error: null, loading: false };
  if (state.path !== path) return { path, data: null, error: null, loading: true };
  return state.loading ? state : { ...state, loading: true };
}

export function resourceSettled<T>(state: ResourceState<T>, result: { data: T } | { error: unknown }): ResourceState<T> {
  return "data" in result
    ? { ...state, data: result.data, error: null, loading: false }
    : { ...state, error: result.error, loading: false };
}

/**
 * GET `path` through `api()` whenever `path` or `deps` change. A `null` path
 * means "not now" (offline, not permitted). Responses for superseded requests
 * are dropped.
 */
export function useApiResource<T>(path: string | null, deps: DependencyList = [], init?: RequestInit): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>(() => ({ path, data: null, error: null, loading: path !== null }));
  const scope = useRequestScope();
  const initRef = useRef(init);
  initRef.current = init;

  const reload = useCallback(async () => {
    const token = scope.begin();
    setState((current) => resourceStarted(current, path));
    if (path === null) return;
    try {
      const data = await api<T>(path, initRef.current);
      if (scope.current(token)) setState((current) => resourceSettled(current, { data }));
    } catch (error) {
      if (scope.current(token)) setState((current) => resourceSettled(current, { error }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, scope, ...deps]);

  useEffect(() => {
    void reload();
    return () => scope.clear();
  }, [reload, scope]);

  const setData = useCallback<Dispatch<SetStateAction<T | null>>>((next) => {
    setState((current) => ({ ...current, data: typeof next === "function" ? (next as (previous: T | null) => T | null)(current.data) : next }));
  }, []);

  // Until the effect commits, a changed path must not expose the old path's data.
  const fresh = state.path === path;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: fresh ? state.loading : path !== null,
    reload,
    setData,
  };
}
