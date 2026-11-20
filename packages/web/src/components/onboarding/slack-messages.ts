/**
 * Slack error codes and connect outcomes in words a person can act on —
 * shared by the automatic setup and the paste-two-tokens path.
 */
import type { SlackConnectResult } from "@/lib/api"

/** Slack's error codes and our normalized ones, in words a person can act on. */
export function describeSlackError(code: string | undefined): string {
  switch (code) {
    case "invalid_auth": return "トークンが無効です"
    case "not_authed": return "トークンが送られていません"
    case "account_inactive": return "このトークンのアカウントは無効化されています"
    case "network_error": return "Slack に接続できませんでした（ネットワークを確認）"
    case undefined: return "確認に失敗しました"
    default: return code.startsWith("http_") ? `Slack が HTTP ${code.slice(5)} を返しました` : code
  }
}

/** A save that Slack accepted but the connector could not start — and what
 *  state the install was left in, stated honestly rather than optimistically. */
export function describeReloadFailure(outcome: SlackConnectResult): string {
  const head = `トークンは正しいのに接続の起動に失敗しました: ${outcome.error ?? "不明なエラー"}。`
  // "Rolled back" means two different things depending on what was there
  // before: an old connection is running again, or Slack is simply
  // unconfigured again. Say which.
  const wasUnconfigured = outcome.previous === "none"
  if (outcome.rolledBack) {
    return wasUnconfigured
      ? `${head}保存した設定は取り消し、接続前の状態（Slack 未接続）に戻しました。`
      : `${head}以前の Slack 設定に戻し、再接続しました。`
  }
  if (outcome.rollbackSkipped) return `${head}その間に設定が別の場所から変更されたため、元に戻す操作は行っていません。設定ページで現在の Slack 設定を確認してください。`
  if (outcome.restored?.disk && !outcome.restored.running) {
    return wasUnconfigured
      ? `${head}保存した設定はファイルから取り除きましたが、コネクタの再起動でエラーが出ています（${outcome.rollbackError ?? "原因不明"}）。設定ページで確認してください。`
      : `${head}以前の設定はファイルに戻しましたが、その接続も起動できていません（${outcome.rollbackError ?? "原因不明"}）。設定ページで確認してください。`
  }
  return `${head}以前の設定に戻せませんでした（${outcome.rollbackError ?? "原因不明"}）。設定ページで Slack 設定を確認してください。`
}

/** One connect outcome (verify refused / started / rolled back) as a message. */
export function describeConnectOutcome(outcome: SlackConnectResult): { ok: boolean; message: string } {
  if (outcome.ok) {
    return { ok: true, message: `接続できました（ワークスペース: ${outcome.team ?? "?"} / Bot: ${outcome.user ?? "?"}）。Slack でメンションしてみてください` }
  }
  if (outcome.stage === "verify") {
    const parts: string[] = []
    if (outcome.bot && !outcome.bot.ok) parts.push(`Bot Token: ${describeSlackError(outcome.bot.error)}`)
    if (outcome.app && !outcome.app.ok) parts.push(`App Token: ${describeSlackError(outcome.app.error)}（アプリの Socket Mode が有効で、connections:write スコープがあるか確認）`)
    return { ok: false, message: `保存していません。${parts.join(" / ") || "トークンを確認できませんでした"}` }
  }
  if (outcome.stage === "reload") return { ok: false, message: describeReloadFailure(outcome) }
  return { ok: false, message: describeSlackError(outcome.error) }
}

/** Codes from the automatic setup (slack-provision on the gateway). */
export function describeProvisionError(code: string): string {
  switch (code) {
    case "config_token_required": return "設定トークン（xoxe-…）を貼ってください"
    case "invalid_refresh_token":
    case "invalid_auth":
    case "token_expired": return "このトークンは使えません。Slack で新しい設定トークンを作って貼り直してください"
    case "rate_limited":
    case "ratelimited": return "Slack への試行が多すぎます。1分ほど待ってからもう一度"
    case "invalid_state": return "Slack からの戻りを確認できませんでした。もう一度「Slack で許可する」から"
    case "wrong_workspace": return "設定トークンと別のワークスペースで許可されました。同じワークスペースを選んでください"
    case "bot_token_required": return "Slack でのインストールがまだ済んでいません"
    case "invalid_manifest": return "Slack がアプリ定義を受け付けませんでした（名前を変えて再度お試しください）"
    default: return describeSlackError(code)
  }
}
