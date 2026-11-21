import { Component, type ComponentChildren } from 'preact';

type Props = { children: ComponentChildren };
type State = { error: Error | null; attempt: number };

/**
 * Catches a render error anywhere in the board, so one bad agent or message shows a
 * recoverable screen instead of a blank page. "Try again" remounts the app (the store
 * refetches state); "Reload" is the fallback when the error survives a remount.
 */
export class CrashScreen extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error('[bridge-board] render failed', error);
  }

  retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  render() {
    const { error, attempt } = this.state;
    if (!error)
      return (
        <div key={attempt} style={{ display: 'contents' }}>
          {this.props.children}
        </div>
      );
    return (
      <main class="splash">
        <div class="login" role="alert">
          <h1 class="brand">Board out of service</h1>
          <p class="muted">
            Part of the board failed to draw. The agents and their messages are
            not affected; only this page is.
          </p>
          <div class="error">
            <p>{error.message || 'Unknown error'}</p>
          </div>
          <button type="button" class="btn btn--primary" onClick={this.retry}>
            Try again
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => location.reload()}
          >
            Reload the page
          </button>
        </div>
      </main>
    );
  }
}
