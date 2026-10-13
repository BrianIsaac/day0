# Day0 behind your reverse proxy

People reach a customer install of Day0 through the customer's own https
proxy, never at the machine's plain ports. This page says what that proxy
must carry, gives a configuration for Caddy and one for nginx, and names the
check that proves yours. Day0 installs no proxy and starts none: the proxy
is yours, on the machine or beside it.

Both configurations below are the files a test bed ran on 13 October 2026,
with a customer's names where the bed read its own addresses from its
environment; each section says what differs. The bed ran them in front of
`./setup.sh install` to its last check, a sign-in, a live page and a
streamed reply ("What was run", at the foot).

## What the proxy must carry

Two https origins, since a person's browser calls both:

| Origin | The setting that names it | Forwards to | Must |
|---|---|---|---|
| The app, for example `https://day0.acme.com` | `DAY0_PUBLIC_URL` (`--public-url`) | `127.0.0.1:3000`, where `pnpm start` listens | pass a streamed reply on as it arrives; wait longer than 60 s for one |
| The backend, for example `https://convex.day0.acme.com` | `NEXT_PUBLIC_CONVEX_URL` (`--backend-url`) | `127.0.0.1:3210`, the backend's port | pass the WebSocket upgrade; hold the connection open |

Nothing else is published. The backend's second port (3211, its HTTP
routes) is called by Day0's own services and never by a browser, and the
dashboard is for whoever administers the machine.

Day0 reads no forwarded header to decide who a request came from or which
origin it was sent to. Its routes compare a request's `Origin` with
`DAY0_PUBLIC_URL`, which is why that setting must be the address people
type, byte for byte. Next.js, which serves the pages, compares a form's
`Origin` with the `Host` it received, so the proxy passes the `Host` header
through as the browser sent it. Caddy does that unasked; nginx needs the
line the configuration below carries.

## The app

`pnpm start` listens on `127.0.0.1`, port 3000, so the app's plain port is
not on your network beside the proxy. Before v0.21.0 it listened on every
interface.

- **Another port**: `PORT` in the shell, else `DAY0_APP_PORT` in
  `.env.local`, else 3000. The install says which when it waits for the app.
- **Another address**: `DAY0_APP_HOST` in `.env.local`, for a proxy on
  another machine. Name the interface that machine reaches, and keep the port
  closed to everything else.
- **The streamed replies**: the one-to-one (`/api/voice/chat`) and the
  Discuss talk (`/api/reorientation/chat`) answer as `text/event-stream`, a
  few words at a time, and carry `X-Accel-Buffering: no`. nginx reads that
  header and passes each piece on as it arrives; told to ignore it, nginx
  on the bed held the whole reply and delivered it as one piece at its end.
  A proxy that does not read the header needs buffering turned off for
  those two paths, as the Caddy configuration does for the origin.
- **The read timeout**: a reply's first words can take the model more than
  a minute, and nginx gives an upstream 60 s unasked. Give the app's origin
  120 s or more.
- **The body size**: a page's form may post up to 4 MB. nginx allows 1 MB
  unasked.

What `pnpm check:setup` says about this origin:

| It says | Meaning | Do |
|---|---|---|
| `pass https://day0.acme.com answers as Day0 over https.` | The proxy forwards to the app: the answer carried the app's own mark, the response header `X-Day0: app` | nothing |
| `gap https://day0.acme.com answered, and not as Day0: check the proxy forwards to port 3000` | Something else answered: the proxy's default site, or the backend's port | point the origin at the app's port |
| `note https://day0.acme.com answered HTTP 502: the proxy has nothing to forward to on port 3000 yet.` | The proxy is right and the app is not running | `pnpm start`, then run the check again |
| `note https://day0.acme.com did not answer (ECONNREFUSED).` | Nothing listens at the address | start the proxy, or correct `DAY0_PUBLIC_URL` |

A note becomes a gap in `./setup.sh install`, which checks after it has
built the app and waited for it.

## The backend

The backend listens on `127.0.0.1`, port 3210 (`CONVEX_PORT`;
`CONVEX_BIND_ADDR` names another address for a proxy on another machine).
`./setup.sh install --backend-url https://convex.day0.acme.com` writes the
origin people's browsers use for it, which must be https and not this
machine's own name, and every later push, resume and upgrade keeps it.

A page holds one connection to this origin for as long as it is open: a
WebSocket, at `/api/<version>/sync`. Everything a page shows arrives over
it, so a proxy that does not pass the upgrade gives a page that signs in
and then stays empty.

- **The upgrade headers**: pass `Upgrade` and `Connection` on. Caddy does
  it unasked. nginx does not: it needs the three lines the configuration
  below carries (`proxy_http_version 1.1` and the two `proxy_set_header`
  lines, with the `map` above them).
- **The timeouts**: the connection is quiet between changes. Give this
  origin a read and send timeout of an hour, or your proxy's longest.

What `pnpm check:setup` says about this origin:

| It says | Meaning | Do |
|---|---|---|
| `pass https://convex.day0.acme.com carries the live connection.` | The check asked for a WebSocket through the proxy and got one | nothing |
| `gap https://convex.day0.acme.com did not complete the WebSocket upgrade: add the upgrade headers` | The proxy answered the request as plain http | add the upgrade headers |
| `gap https://convex.day0.acme.com did not answer (ECONNREFUSED): check the proxy forwards it to port 3210` | Nothing listens at the address | start the proxy, or correct `--backend-url` |

On the bed, nginx with the two header lines taken out gave the second row,
and `./setup.sh install` stopped on it at its first step.

## The certificate

The certificate, its renewal and HSTS are yours to set at the proxy: Day0
sends no `Strict-Transport-Security` header, since only the proxy knows
whether every name under the domain is served over https.

Where the certificate comes from your own certificate authority, three
things on this machine must trust that authority, each by the bundle's path:

- the install and the checks: `NODE_EXTRA_CA_CERTS=<bundle> ./setup.sh
  install ...`, and the same in front of `pnpm check:setup`. Without it the
  check says the address "presents a certificate this machine's Node does
  not trust", naming this section;
- the app, which calls the backend's origin and your identity provider
  from its own server: `NODE_EXTRA_CA_CERTS=<bundle> pnpm start`, or the
  variable in your service manager's unit;
- the backend container, where it reaches a host your authority signs: see
  [the install runbook](install.md), step 6.

Where the machine also goes out through an HTTP proxy, list Day0's two
names in `NO_PROXY`, so the app and the checks reach them directly
([the way out](egress.md)).

## Caddy

```caddyfile
# The app: `pnpm start`, on 127.0.0.1.
https://day0.acme.com {
	tls /etc/day0/tls/cert.pem /etc/day0/tls/key.pem
	reverse_proxy 127.0.0.1:3000 {
		# The 1:1 and the Discuss talk stream their replies: each chunk is passed on as it arrives.
		flush_interval -1
	}
}

# The backend: the browser's live connection is a WebSocket here, which Caddy upgrades unasked.
https://convex.day0.acme.com {
	tls /etc/day0/tls/cert.pem /etc/day0/tls/key.pem
	reverse_proxy 127.0.0.1:3210
}
```

Leave the two `tls` lines out and Caddy obtains and renews certificates
for the two names itself, where they are public names it can prove. The
bed's own file (`docker/proxy-bed/Caddyfile`) is this one with its
addresses and ports read from the bed's environment, a `bind` line for
each site, and two global options a throwaway certificate needed
(`auto_https off`, `admin off`).

## nginx

Save it as a file of its own under `/etc/nginx/conf.d/`, which nginx reads
inside its `http` block: the `map` at its head is allowed nowhere else.

```nginx
# The live connection: a request that asks to upgrade is passed on as one, any other is not.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# The app: `pnpm start`, on 127.0.0.1.
server {
    listen 443 ssl;
    server_name day0.acme.com;
    ssl_certificate     /etc/day0/tls/cert.pem;
    ssl_certificate_key /etc/day0/tls/key.pem;

    # A page's form posts up to 4 MB (next.config.mjs, serverActions); nginx allows 1 MB unasked.
    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        # The host people typed, which Day0 checks a request's origin against.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # A streamed reply may take the model a minute; nginx gives an upstream 60 s unasked.
        proxy_read_timeout 120s;
        # Buffering stays on: the two streamed routes send `X-Accel-Buffering: no` themselves.
    }
}

# The backend: the browser's live connection is a WebSocket here.
server {
    listen 443 ssl;
    server_name convex.day0.acme.com;
    ssl_certificate     /etc/day0/tls/cert.pem;
    ssl_certificate_key /etc/day0/tls/key.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $http_host;
        # The connection stays open for as long as a page does.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

The bed's own file (`docker/proxy-bed/nginx.conf.template`) is this one
with its addresses and ports read from the bed's environment. It told its
two servers apart by port, on one address; the two `server_name` lines
are how yours are told apart on port 443, and they are the one part of this
configuration the bed did not run. As printed, with a certificate for the
two names, the file passes `nginx -t`, and the Caddy file above passes
`caddy validate`.

## The check

`pnpm check:setup` asks both origins from this machine whenever
`DAY0_PUBLIC_URL` is an https address that is not this machine's own, and
prints the two rows under "Auth". `./setup.sh install` ends on them: it
builds the app, waits for it at the public address, and stops with the gap
if either row is one. Run it again once the proxy is corrected; every step
before it keeps what it wrote.

The check is asked from this machine only. The backend never calls Day0's
public address, so nothing is asked from inside its container.

## What was run

On the bed `day0-w17p`, 13 October 2026: Day0 in real mode under a test
identity provider, the two origins on a private certificate authority,
Caddy 2 and then nginx 1.29 in front, each with the configuration above.

| What | Caddy | nginx |
|---|---|---|
| `./setup.sh install` to its last check | passed, 1 min 14 s | passed, 1 min 53 s (the app built again) |
| A sign-in through the proxy | completed | completed |
| The live connection | open, frames both ways | open, the upgrade answered `101` in nginx's log |
| A streamed one-to-one reply | 22 pieces over 1.2 s | 23 pieces over 0.7 s |
| The same reply with nginx told to ignore `X-Accel-Buffering` | | 1 piece, at its end |
| The backend's origin with the upgrade headers taken out | | the gap, and the install stopped on it |
| The app's origin forwarded to the backend's port | | the gap "answered, and not as Day0" |
