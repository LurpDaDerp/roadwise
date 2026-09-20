import { randomUUID } from 'expo-crypto';

export const newClientTripId = () => randomUUID();
export const newIdempotencyKey = (prefix: string) => `${prefix}:${randomUUID()}`;
