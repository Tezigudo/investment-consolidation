import AsyncStorage from '@react-native-async-storage/async-storage';

// Order of resolution:
//   1. Runtime override saved in AsyncStorage from the Settings screen.
//   2. EXPO_PUBLIC_API_URL baked at bundle time (apps/mobile/.env.local).
//   3. Hard fallback to localhost — only useful in the iOS simulator.
//
// The baked env var is the path of least resistance: set it once in
// .env.local to your Mac's LAN IP (e.g. http://192.168.1.42:4000) and
// the app just works on a real device on the same Wi-Fi.
const URL_KEY = '@consolidate/apiUrl';
const TOKEN_KEY = '@consolidate/apiToken';
const ENV_URL = process.env.EXPO_PUBLIC_API_URL || '';
const FALLBACK = 'http://localhost:4000';

let cachedUrl: string | null = null;
let cachedToken: string | null = null;

export async function getApiUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  const stored = await AsyncStorage.getItem(URL_KEY);
  cachedUrl = stored || ENV_URL || FALLBACK;
  return cachedUrl;
}

export async function setApiUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/$/, '');
  await AsyncStorage.setItem(URL_KEY, trimmed);
  cachedUrl = trimmed;
}

export async function getApiToken(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  const stored = await AsyncStorage.getItem(TOKEN_KEY);
  cachedToken = stored || '';
  return cachedToken;
}

export async function setApiToken(token: string): Promise<void> {
  const trimmed = token.trim();
  await AsyncStorage.setItem(TOKEN_KEY, trimmed);
  cachedToken = trimmed;
}

export function getApiUrlSync(): string {
  return cachedUrl || ENV_URL || FALLBACK;
}
