import { AutoCreatorProfile } from './AutoTypes'

let currentProfile: AutoCreatorProfile | null = null

export function setAutoProfile(profile: AutoCreatorProfile | null) {
  currentProfile = profile
}

export function getAutoProfile() {
  return currentProfile
}
