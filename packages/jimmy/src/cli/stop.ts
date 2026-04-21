import { stop } from "../gateway/lifecycle.js";

export async function runStop(port?: number): Promise<void> {
  const stopped = stop(port);
  if (stopped) {
    console.log("ゲートウェイを停止しました。");
  } else {
    console.log("ゲートウェイは起動していません。");
  }
}
