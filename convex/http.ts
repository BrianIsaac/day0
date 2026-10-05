import { httpRouter } from 'convex/server';
import { bridgeApps, bridgeConnection, bridgeHeartbeat, bridgePress } from './slackSocket';

/**
 * The deployment's HTTP routes: only the Socket Mode bridge's (wave 12, 12-M; RM7), each behind
 * the bridge's generated secret. They are served on the backend's site port, which the compose
 * file binds to loopback and the bridge reaches over the compose network; no route is meant for
 * the internet, and none answers without the secret (Q13).
 */
const http = httpRouter();

http.route({ path: '/slack-socket/apps', method: 'POST', handler: bridgeApps });
http.route({ path: '/slack-socket/connection', method: 'POST', handler: bridgeConnection });
http.route({ path: '/slack-socket/press', method: 'POST', handler: bridgePress });
http.route({ path: '/slack-socket/heartbeat', method: 'POST', handler: bridgeHeartbeat });

export default http;
