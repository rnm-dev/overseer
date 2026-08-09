export interface AuthBootstrapRef<T> {
  current: Promise<T> | null;
}

// React StrictMode replays mount effects in development. Keep the in-flight
// bootstrap on the component ref so both effect generations observe one request.
export function getOrStartAuthBootstrap<T>(
  ref: AuthBootstrapRef<T>,
  start: () => Promise<T>,
): Promise<T> {
  ref.current ??= start();
  return ref.current;
}
