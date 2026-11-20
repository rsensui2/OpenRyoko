/**
 * The bot's Slack picture as Slack's apps.icon.set wants it: a PNG between
 * 512 and 2000px. Uploads are center-cropped to a 512px square; with no
 * upload, a picture is drawn from the name's first character on a color.
 */

export const SLACK_ICON_PX = 512

export const SLACK_ICON_COLORS = ["#3B82F6", "#8B5CF6", "#EC4899", "#F97316", "#10B981", "#0EA5E9", "#334155"] as const

function canvas(): { element: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const element = document.createElement("canvas")
  element.width = SLACK_ICON_PX
  element.height = SLACK_ICON_PX
  const context = element.getContext("2d")
  if (!context) throw new Error("この環境では画像を作れません（canvas 非対応）")
  return { element, context }
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")) }
    image.src = url
  })
}

/** Any browser-readable image → 512px square PNG data URL (cover crop). */
export async function imageFileToSlackIcon(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください")
  const image = await loadImage(file)
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  if (side === 0) throw new Error("画像の大きさを読み取れませんでした")
  const { element, context } = canvas()
  const sx = (image.naturalWidth - side) / 2
  const sy = (image.naturalHeight - side) / 2
  context.drawImage(image, sx, sy, side, side, 0, 0, SLACK_ICON_PX, SLACK_ICON_PX)
  return element.toDataURL("image/png")
}

/** A plain picture from the name: its first character, white on `color`. */
export function initialSlackIcon(name: string, color: string): string {
  const { element, context } = canvas()
  context.fillStyle = color
  context.fillRect(0, 0, SLACK_ICON_PX, SLACK_ICON_PX)
  const initial = Array.from(name.trim())[0] ?? "R"
  context.fillStyle = "#FFFFFF"
  context.font = `600 ${Math.round(SLACK_ICON_PX * 0.5)}px system-ui, -apple-system, "Hiragino Sans", sans-serif`
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText(initial.toUpperCase(), SLACK_ICON_PX / 2, SLACK_ICON_PX / 2 + SLACK_ICON_PX * 0.03)
  return element.toDataURL("image/png")
}
