"use client"
import { useState, useRef, useCallback, useEffect } from "react"
import { api } from "@/lib/api"

export type SttState =
  | "idle"           // mic not active
  | "no-model"       // model not downloaded, need to show download modal
  | "recording"      // actively recording
  | "transcribing"   // audio sent, waiting for result

export interface UseSttReturn {
  state: SttState
  available: boolean | null
  downloadProgress: number | null
  analyser: AnalyserNode | null
  /** Configured languages from the gateway */
  languages: string[]
  /** Currently selected language for transcription */
  selectedLanguage: string
  /** Cycle to the next language */
  cycleLanguage: () => void
  handleMicClick: () => void
  startRecording: () => Promise<void>
  stopRecording: () => Promise<string | null>
  cancelRecording: () => void
  startDownload: () => void
  dismissDownload: () => void
}

const MAX_RECORDING_MS = 60_000

export function useStt(
  wsEvents?: Array<{ event: string; payload: unknown }>,
): UseSttReturn {
  const [state, setState] = useState<SttState>("idle")
  const [available, setAvailable] = useState<boolean | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [languages, setLanguages] = useState<string[]>(["en"])
  const [selectedLanguage, setSelectedLanguage] = useState<string>(() => {
    if (typeof window === "undefined") return "en"
    return localStorage.getItem("stt-language") || "en"
  })

  const selectedLanguageRef = useRef(selectedLanguage)
  selectedLanguageRef.current = selectedLanguage

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Process WebSocket events for download progress
  useEffect(() => {
    if (!wsEvents || wsEvents.length === 0) return
    const latest = wsEvents[wsEvents.length - 1]
    if (!latest.event.startsWith("stt:")) return

    const p = latest.payload as Record<string, unknown>
    if (latest.event === "stt:download:progress") {
      setDownloadProgress(Number(p.progress) || 0)
    }
    if (latest.event === "stt:download:complete") {
      setDownloadProgress(null)
      setAvailable(true)
      setState("idle")
    }
    if (latest.event === "stt:download:error") {
      setDownloadProgress(null)
      setState("idle")
    }
  }, [wsEvents])

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    setAnalyser(null)
    mediaRecorderRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop()
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioContextRef.current?.close().catch(() => {})
    }
  }, [])

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.sttStatus()
      setAvailable(status.available)
      if (status.downloading) {
        setDownloadProgress(status.progress)
      }
      if (status.languages?.length > 0) {
        setLanguages(status.languages)
        // If the stored language isn't in the configured list, reset to the first
        setSelectedLanguage((prev) => {
          if (!status.languages.includes(prev)) {
            const fallback = status.languages[0]
            localStorage.setItem("stt-language", fallback)
            return fallback
          }
          return prev
        })
      }
      return status.available
    } catch {
      setAvailable(false)
      return false
    }
  }, [])

  const startRecordingInner = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 128
      source.connect(analyserNode)
      setAnalyser(analyserNode)

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : ""
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.start(100)
      setState("recording")

      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop()
        }
      }, MAX_RECORDING_MS)
    } catch {
      cleanup()
      setState("idle")
    }
  }, [cleanup])

  const handleMicClick = useCallback(async () => {
    if (state === "recording" || state === "transcribing") return

    const isAvailable = await checkStatus()
    if (isAvailable) {
      await startRecordingInner()
    } else {
      setState("no-model")
    }
  }, [state, checkStatus, startRecordingInner])

  const startRecording = useCallback(async () => {
    await startRecordingInner()
  }, [startRecordingInner])

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      setState("idle")
      return null
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current!

      recorder.onstop = async () => {
        cleanup()
        setState("transcribing")

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        })
        chunksRef.current = []

        if (blob.size === 0) {
          setState("idle")
          resolve(null)
          return
        }

        try {
          const result = await api.sttTranscribe(blob, selectedLanguageRef.current)
          setState("idle")
          resolve(result.text || null)
        } catch {
          setState("idle")
          resolve(null)
        }
      }

      if (recorder.state === "recording") {
        recorder.stop()
      } else {
        cleanup()
        setState("idle")
        resolve(null)
      }
    })
  }, [cleanup])

  const cancelRecording = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop()
    }
    cleanup()
    chunksRef.current = []
    setState("idle")
  }, [cleanup])

  const startDownload = useCallback(() => {
    setDownloadProgress(0)
    api.sttDownload().catch(() => {
      setDownloadProgress(null)
    })
  }, [])

  const dismissDownload = useCallback(() => {
    setState("idle")
    setDownloadProgress(null)
  }, [])

  const cycleLanguage = useCallback(() => {
    setSelectedLanguage((prev) => {
      const idx = languages.indexOf(prev)
      const next = languages[(idx + 1) % languages.length]
      localStorage.setItem("stt-language", next)
      return next
    })
  }, [languages])

  return {
    state,
    available,
    downloadProgress,
    analyser,
    languages,
    selectedLanguage,
    cycleLanguage,
    handleMicClick,
    startRecording,
    stopRecording,
    cancelRecording,
    startDownload,
    dismissDownload,
  }
}
