import { updateConfigDocument } from "../shared/config-file.js";

/** Write the `stt` block of config.yaml through the shared config writer. */
function updateSttBlock(change: (stt: Record<string, unknown>) => Record<string, unknown>): void {
  updateConfigDocument((config) => {
    const current = config.stt;
    const stt = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
    return { ...config, stt: change(stt) };
  });
}

/** A Whisper model finished downloading: turn voice input on and record which one. */
export function markSttModelInstalled(model: string): void {
  updateSttBlock((stt) => ({ ...stt, enabled: true, model, languages: stt.languages || ["en"] }));
}

/** Replace the transcription languages; the deprecated single `language` key goes. */
export function saveSttLanguages(languages: string[]): void {
  updateSttBlock(({ language: _deprecated, ...stt }) => ({ ...stt, languages }));
}
