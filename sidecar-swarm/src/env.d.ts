// Minimal ambient typing for Bun's non-standard `fetch` unix-socket option.
// Bun accepts `{ unix: "/path/to.sock" }` in RequestInit to route the request
// over a unix domain socket. This augments the global RequestInit so we do not
// need @types/bun (keeps the sidecar at zero npm dependencies).

export {}

declare global {
  interface RequestInit {
    /** Bun-only: route the fetch over this unix domain socket path. */
    unix?: string
  }
}
