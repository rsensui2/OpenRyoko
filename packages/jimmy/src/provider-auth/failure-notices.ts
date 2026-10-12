import type { AuthClock, AuthFailureNotifier, AuthLogger, AuthProvider } from "./types.js";

/** At most one "you can log in again" notice per provider in this window. */
export const NOTICE_INTERVAL_MS = 30 * 60_000;
/** When a notice could not be delivered, the next failing turn may try sooner. */
export const NOTICE_RETRY_MS = 5 * 60_000;

interface NoticeOptions {
  clock: Pick<AuthClock, "now">;
  logger: AuthLogger;
  /** A notice is pointless while the operator is already logging that provider in. */
  isLoginInProgress: (provider: AuthProvider) => boolean;
}

/**
 * Turns a stream of failing turns into at most one operator notice per
 * provider per window. An expired login fails every turn, and cron fires
 * several at once — the window is claimed before the first delivery starts so
 * a burst cannot slip through it.
 */
export class AuthFailureNotices {
  private readonly notifiers = new Set<AuthFailureNotifier>();
  private readonly nextAt = new Map<AuthProvider, number>();

  constructor(private readonly options: NoticeOptions) {}

  add(notifier: AuthFailureNotifier): () => void {
    this.notifiers.add(notifier);
    return () => { this.notifiers.delete(notifier); };
  }

  report(provider: AuthProvider): void {
    if (this.notifiers.size === 0 || this.options.isLoginInProgress(provider)) return;
    const now = this.options.clock.now();
    if (now < (this.nextAt.get(provider) ?? 0)) return;
    this.nextAt.set(provider, now + NOTICE_INTERVAL_MS);
    void this.deliver(provider).then((delivered) => {
      if (delivered) return;
      this.nextAt.set(provider, now + NOTICE_RETRY_MS);
      this.options.logger.warn(`[provider-auth] could not tell the operator about the ${provider} login failure`);
    });
  }

  /** The first connector that delivers wins, so the operator gets one message. */
  private async deliver(provider: AuthProvider): Promise<boolean> {
    for (const notifier of [...this.notifiers]) {
      try {
        if (await notifier(provider)) return true;
      } catch { /* try the next connector */ }
    }
    return false;
  }
}
