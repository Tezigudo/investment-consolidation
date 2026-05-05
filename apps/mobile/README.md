# Consolidate — mobile (iOS, local use)

Expo + React Native client for the same Postgres-backed API the web dashboard uses. Designed for personal/local use over LAN — not for the App Store.

## First-time setup

1. **Install deps** (from the repo root):
   ```bash
   bun install
   ```

2. **Find your Mac's LAN IP** — System Settings → Network → Wi-Fi → Details → IP Address. Looks like `192.168.1.42`.

3. **Configure the API URL** (one of these — pick whichever):
   - Edit `apps/mobile/.env.local`:
     ```
     EXPO_PUBLIC_API_URL=http://192.168.1.42:4000
     ```
     Restart Metro after changing.
   - Or set it in-app: open Settings → Server → paste URL → Save.

4. **Start the API** (binds 0.0.0.0 so the phone can reach it):
   ```bash
   bun run dev:api
   ```

5. **Start the mobile app** (LAN mode):
   ```bash
   bun run dev:mobile
   ```
   Scan the QR with the Expo Go app on your iPhone. Phone and Mac must be on the same Wi-Fi.

## Off-LAN access (recommended)

Install [Tailscale](https://tailscale.com) on Mac + iPhone. Use the Mac's Tailscale IP (`100.x.x.x`) as `EXPO_PUBLIC_API_URL` and the app keeps working anywhere.

## Native builds (optional)

Expo Go is enough for daily use. If you want a standalone app on your phone (Face ID gating, app icon on home screen):

```bash
cd apps/mobile
bunx expo prebuild           # generates ios/ folder
bun run ios                  # builds + installs to a simulator/device
```

## Layout

```
app/
  _layout.tsx          Root Stack + Face ID gate + Query provider
  (tabs)/
    index.tsx          Portfolio (hero net worth, breakdown, movers)
    positions.tsx      All positions with filter pills + sort + DIME-view toggle
    activity.tsx       Trade history
    settings.tsx       Server URL, sync triggers, default cost view
  position/[symbol].tsx  Detail (chart, stats, trades) — replaces PriceModal

src/
  api/                 Mirror of apps/web/src/api/client.ts, LAN-aware
  components/          Card / Stat / SegmentedControl / FilterPills / PlatformBadge / PriceChart
  hooks/               TanStack Query client + portfolio/symbol hooks + cost-view persistence
  lib/                 Formatters + price-kind detection (DIME → stock, else → crypto)
  theme/               Color/spacing/typography tokens (matches web's dark theme)
```

`@consolidate/shared` is imported directly from the workspace; no shape duplication.
