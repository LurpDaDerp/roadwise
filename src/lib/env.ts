import { z } from 'zod';

const schema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: z.string().url({ message: 'EXPO_PUBLIC_SUPABASE_URL must be a URL' }),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'EXPO_PUBLIC_SUPABASE_ANON_KEY is required'),
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: z.string().optional(),
});

// Expo inlines `process.env.EXPO_PUBLIC_*` at build time only where each name is spelled out
// literally, so read every key by hand rather than handing the whole `process.env` to the schema.
const parsed = schema.safeParse({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY,
});

if (!parsed.success) {
  // Name the offending key: a missing value yields Zod's generic "expected string, received
  // undefined", which on its own tells nobody which variable to set.
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');
  throw new Error(`RoadWise is not configured: ${details}. Copy .env.example to .env.`);
}

export const env = {
  supabaseUrl: parsed.data.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: parsed.data.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  googleWebClientId: parsed.data.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  googleIosClientId: parsed.data.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  googleAndroidClientId: parsed.data.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  googleMapsAndroidKey: parsed.data.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY,
};
