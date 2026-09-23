export type RenewedInvitations = Record<string, { token: string; expiresAt: number }>
export function invitationUrl(token: string) {
  const url = new URL(location.href); url.search = ''; url.hash = `invite=${token}`
  return url.href
}
