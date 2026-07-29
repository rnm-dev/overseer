export interface ToggleState {
  paused: boolean;
  previous: boolean;
  loading: boolean;
  error: string | null;
}

export function beginToggle(paused: boolean): ToggleState {
  return { paused: !paused, previous: paused, loading: true, error: null };
}

export function finishToggle(state: ToggleState): ToggleState {
  return { ...state, loading: false, error: null };
}

export function failToggle(state: ToggleState, error: string): ToggleState {
  return { paused: state.previous, previous: state.previous, loading: false, error };
}
