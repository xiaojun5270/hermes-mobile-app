# Hermes Mobile

An **unofficial, open-source iOS client** for [hermes-agent](https://github.com/NousResearch/hermes-agent) —
chat with your self-hosted Hermes from your phone, over your own private network.

<p align="center">
  <img src="docs/screenshots/light.png" alt="Hermes Mobile — light mode" width="44%" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/dark.png" alt="Hermes Mobile — dark mode" width="44%" />
</p>

- 🔒 **Private by construction** — the app talks only to *your* gateway over Tailscale/VPN/LAN.
  No third-party backend, no telemetry, nothing leaves your network.
- 💬 **Real chat experience** — streaming responses, rendered markdown, expandable tool-call
  cards with live status and durations, haptics, session continuation (`session.resume`).
- 🔁 **Resilient** — automatic WebSocket reconnection with fresh auth tickets, silent
  re-login on session expiry, offline-aware error states.
- 🎨 **Native polish** — warm dark theme with full light-mode support, large-title headers,
  native search, settings sheet, VoiceOver labels.

> This is a community project, not affiliated with or endorsed by Nous Research.

## Requirements

- A running [hermes-agent](https://github.com/NousResearch/hermes-agent) dashboard, reachable
  from your phone (same LAN or tailnet)
- iOS 18+; for development: Xcode + an Apple developer account (the app uses a dev/standalone
  build — Expo Go ships SDK 54 and can't run this SDK 56 project)

## Gateway setup

```bash
export HERMES_DASHBOARD_BASIC_AUTH_USERNAME=you
export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='a strong password'
hermes dashboard --no-open --host <lan-or-tailscale-ip> --port 9119
```

The non-loopback bind enables the dashboard's auth gate (required). Do **not** use
`--insecure`. In the app, enter `http://<that-ip>:9119` plus the credentials.

## Development

```bash
npm install
npx expo start              # JS development (hot reload)
npx expo run:ios --device   # build the dev client onto a phone (first time / native changes)
npx jest && npx tsc --noEmit
```

See `READY.md` for the full first-run walkthrough and `AGENTS.md` for architecture and
conventions. Design docs live in `docs/`.

## Unsigned IPA

GitHub Actions can build an unsigned device IPA without an Apple certificate:

1. Open **Actions** > **Build unsigned IPA** in the GitHub repository.
2. Select **Run workflow** and choose the branch or tag to build.
3. Download the `Hermes-Mobile-unsigned-*` artifact from the completed run.

Pushing a tag that starts with `ios-v` also starts a build, for example
`git tag ios-v1.0.0 && git push origin ios-v1.0.0`.

The artifact is retained for 14 days. Because it has no code signature, it cannot be
installed directly on a normal iPhone. Sign it separately or use an installation
environment that supports unsigned apps.

## Roadmap

- QR pairing with per-device revocable tokens (server plugin already shipped:
  [hermes-mobile-plugin](../hermes-mobile-plugin))
- Push notifications via Expo push (redacted by default)
- App Store release

## License

[MIT](LICENSE)
