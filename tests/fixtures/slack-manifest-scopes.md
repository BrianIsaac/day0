# Slack automation policy (fixture: the manifest template section as documented on the handbook page; no secrets)

```json
{
  "display_information": { "name": "day0 automation" },
  "oauth_config": {
    "redirect_urls": ["<day0 public URL>/api/oauth/slack"],
    "scopes": { "bot": ["chat:write", "channels:read", "channels:history", "im:read", "im:write", "im:history", "users:read", "users:read.email"] }
  },
  "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false }
}
```

The bot token is never written down; the installing administrator lands it on the connection card.
