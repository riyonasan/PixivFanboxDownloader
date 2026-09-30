export interface AutoCreatorProfile {
  creatorId: string
  name: string
  free: boolean
  pay: boolean
  minFee: number | null
  maxFee: number | null
  since: number
}

export interface AutoPendingPost {
  creatorId: string
  postId: string
  fee: number
  retryAfter?: number
}

export const autoProfilesKey = 'autoCreatorProfiles'
export const autoPendingKey = 'autoPendingPosts'
export const autoActiveKey = 'autoActivePost'
export const autoStatusKey = 'autoDownloadStatus'

export interface AutoStatus {
  lastCheckedAt?: number
  lastCompletedAt?: number
  lastAcceptedAt?: number
  lastError?: string
}

export function matchesAutoFee(profile: AutoCreatorProfile, fee: number) {
  if (fee === 0) {
    return profile.free
  }
  return (
    profile.pay &&
    (profile.minFee === null || fee >= profile.minFee) &&
    (profile.maxFee === null || fee <= profile.maxFee)
  )
}
