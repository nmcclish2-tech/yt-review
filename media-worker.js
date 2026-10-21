// The review page's media worker (docs/design/review-share.md §10). A file's copy shared with
// only certain people needs the reviewer's sign-in to stream, and a <video> cannot send it (Google
// refuses a token in the address for media). So the page plays ./media/<file ID> from its own
// origin, and this worker answers each request, ranges included, from Google Drive with the token
// the page gave it. It holds the token in memory only, and serves nothing else.
// The browser stops an idle worker (a paused video) and starts it again on the next request, empty:
// a request then asks the page for the sign-in again (token-wanted) and waits for it, never falling
// through to the site; with no answer in WAIT_MS it says the sign-in is missing (401). When Google
// says the sign-in has ended (an hour on), or refuses the copy (403/429: its download limit), it
// tells the page, which says so and offers to sign in again or try again.

const MEDIA = /\/media\/([A-Za-z0-9_-]{10,200})$/
// How long a request waits for the page's answer after a restart (no answer: the page is gone).
const WAIT_MS = 10000
let token = null
// The requests waiting for the page's sign-in (each one's resolve).
let waiting = []

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'token' || typeof data.token !== 'string') return
  token = data.token
  waiting.splice(0).forEach((resolve) => resolve(token))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const match = MEDIA.exec(url.pathname)
  if (url.origin !== self.location.origin || !match) return
  const range = event.request.headers.get('range')
  const signedIn =
    token !== null
      ? Promise.resolve(token)
      : new Promise((resolve) => {
          waiting.push(resolve)
          setTimeout(() => {
            if (!waiting.includes(resolve)) return
            waiting = waiting.filter((other) => other !== resolve)
            resolve(null)
          }, WAIT_MS)
          self.clients
            .matchAll({ type: 'window' })
            .then((pages) => pages.forEach((page) => page.postMessage({ type: 'token-wanted' })))
        })
  event.respondWith(
    signedIn.then((held) => {
      if (held === null) return new Response(null, { status: 401 })
      const headers = { Authorization: `Bearer ${held}` }
      if (range) headers.Range = range
      return fetch(`https://www.googleapis.com/drive/v3/files/${match[1]}?alt=media`, {
        headers
      }).then((response) => {
        const refused = response.status === 403 || response.status === 429
        if (response.status === 401 && token === held) token = null
        const told =
          response.status === 401
            ? { type: 'token-ended' }
            : refused
              ? { type: 'media-refused', status: response.status }
              : null
        if (told)
          self.clients
            .matchAll({ type: 'window' })
            .then((pages) => pages.forEach((page) => page.postMessage(told)))
        return response
      })
    })
  )
})
