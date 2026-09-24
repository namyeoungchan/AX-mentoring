let guard: (() => boolean) | undefined

export function registerNavigationGuard(check: () => boolean) {
  guard = check
  return () => { if (guard === check) guard = undefined }
}

export function confirmNavigation() { return guard?.() ?? true }
