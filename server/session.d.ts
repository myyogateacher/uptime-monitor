import 'express-session'

declare module 'express-session' {
  interface SessionData {
    oauthState?: string
    oauthReturnTo?: string
    user?: {
      sub: string
      email?: string
      name?: string
      picture?: string
    }
  }
}
