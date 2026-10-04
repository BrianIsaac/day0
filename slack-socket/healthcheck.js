// The compose healthcheck: the bridge read the app list on its last try.
const port = Number(process.env.SLACK_SOCKET_HEALTH_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`)
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
