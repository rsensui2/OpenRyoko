import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills.all,
    queryFn: () => api.getSkills(),
  })
}

export function useSkill(name: string | null) {
  return useQuery({
    queryKey: queryKeys.skills.detail(name!),
    queryFn: () => api.getSkill(name!),
    enabled: !!name,
  })
}
