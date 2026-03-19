import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useCronJobs() {
  return useQuery({
    queryKey: queryKeys.cron.all,
    queryFn: () => api.getCronJobs(),
  })
}

export function useCronRuns(id: string | null) {
  return useQuery({
    queryKey: queryKeys.cron.runs(id!),
    queryFn: () => api.getCronRuns(id!),
    enabled: !!id,
  })
}

export function useUpdateCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateCronJob>[1] }) =>
      api.updateCronJob(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cron.all }),
  })
}

export function useTriggerCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.triggerCronJob(id),
    onSuccess: (_, id) => qc.invalidateQueries({ queryKey: queryKeys.cron.runs(id) }),
  })
}
