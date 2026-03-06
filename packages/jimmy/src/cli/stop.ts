import { stop } from "../gateway/lifecycle.js";

export async function runStop(): Promise<void> {
  const stopped = stop();
  if (stopped) {
    console.log("Gateway stopped.");
  } else {
    console.log("Gateway is not running.");
  }
}
