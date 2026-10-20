// The review page's media worker (docs/design/review-share.md §10). A file's copy shared with
// only certain people needs the reviewer's sign-in to stream, and a <video> cannot send it (Google
// refuses a token in the address for media). So the page plays ./media/<file ID> from its own
// origin, and this worker answers each request, ranges included, from Google Drive with the token
// the page gave it. It holds the token in memory only, and serves nothing else. When Google says
// the sign-in has ended (an hour on), it tells the page, which signs in again and sends a new one.

const MEDIA = /\/media\/([A-Za-z0-9_-]{10,200})$/
let token = null

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'token' && typeof data.token === 'string') token = data.token
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const match = MEDIA.exec(url.pathname)
  if (url.origin !== self.location.origin || !match || token === null) return
  const headers = { Authorization: `Bearer ${token}` }
  const range = event.request.headers.get('range')
  if (range) headers.Range = range
  event.respondWith(
    fetch(`https://www.googleapis.com/drive/v3/files/${match[1]}?alt=media`, { headers }).then(
      (response) => {
        if (response.status === 401)
          self.clients
            .matchAll()
            .then((pages) => pages.forEach((page) => page.postMessage({ type: 'token-ended' })))
        return response
      }
    )
  )
})
