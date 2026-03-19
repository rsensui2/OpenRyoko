import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: () => api.getSessions(),
  })
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id!),
    queryFn: () => api.getSession(id!),
    enabled: !!id,
  })
}

export function useSessionChildren(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.children(id!),
    queryFn: () => api.getSessionChildren(id!),
    enabled: !!id,
  })
}

export function useSessionTranscript(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.transcript(id!),
    queryFn: () => api.getSessionTranscript(id!),
    enabled: !!id,
  })
}

export function useSessionQueue(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.queue(id!),
    queryFn: () => api.getSessionQueue(id!),
    enabled: !!id,
    refetchInterval: 5_000,
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createSession>[0]) => api.createSession(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useSendMessage() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.sendMessage>[1] }) =>
      api.sendMessage(id, data),
  })
}

export function useStopSession() {
  return useMutation({
    mutationFn: (id: string) => api.stopSession(id),
  })
}
