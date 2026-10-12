/**
 * Remember a successful `auth.test` on a Slack client — and only a successful one.
 *
 * The connector builds Bolt with `tokenVerificationEnabled: false`, because
 * Bolt's default fires auth.test from its constructor and never awaits it.
 * Bolt 4.7's deferred path does not cache, though: it calls auth.test before
 * EVERY incoming event. The ack then waits for that call, and when the call
 * fails no listener runs and socket mode acks the event away — the message is
 * lost without a trace.
 *
 * With this in place the answer is fetched once, by whoever asks first (in
 * practice the connector's own start()). A failure is not remembered: the next
 * caller asks again, so an outage costs the events that arrive during it and
 * nothing after. Callers that arrive while a request is in flight share it.
 *
 * Every caller on this client asks about the same bot token, so the arguments
 * of later calls are not compared.
 */
export function rememberAuthTest<Args, Identity>(auth: { test: (args?: Args) => Promise<Identity> }): void {
  const askSlack = auth.test.bind(auth);
  let known: Promise<Identity> | undefined;

  auth.test = (args?: Args): Promise<Identity> => {
    if (known) return known;
    const attempt = askSlack(args).catch((err: unknown) => {
      if (known === attempt) known = undefined;
      throw err;
    });
    known = attempt;
    return attempt;
  };
}
