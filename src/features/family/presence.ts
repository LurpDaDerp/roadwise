/**
 * Where a member is, in words: "At Home", "Near Capitol Hill", "Driving", each with how long ago the
 * location was shared. Pure: the area name comes from the phone's own reverse geocoding (`useArea`),
 * the place from the family's saved places.
 */
import { haversineMeters } from '@/lib/geo';

import type { FamilyMember, FamilyPlace, MemberLocation } from './api';
import { familyCopy as copy } from './copy';

/** The saved place a location is inside (its radius), the nearest when several overlap; null otherwise. */
export function placeAt(location: Pick<MemberLocation, 'lat' | 'lng'>, places: readonly FamilyPlace[]): FamilyPlace | null {
  let best: { place: FamilyPlace; d: number } | null = null;
  for (const place of places) {
    const d = haversineMeters({ lat: location.lat, lng: location.lng }, { lat: place.lat, lng: place.lng });
    if (d <= place.radiusM && (best === null || d < best.d)) best = { place, d };
  }
  return best?.place ?? null;
}

/** "just now" under a minute, then minutes, then hours (a location is never shown past a day). */
export function freshness(updatedAt: string, now: number): string {
  const ms = now - Date.parse(updatedAt);
  if (!Number.isFinite(ms) || ms < 60_000) return copy.status.justNow;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return copy.status.minutesAgo(minutes);
  return copy.status.hoursAgo(Math.floor(minutes / 60));
}

export interface PresenceLine {
  /** "At Home", "Near Capitol Hill", "Driving", "Location sharing off"… */
  where: string;
  /** "5 min ago", or null when there is no location. */
  when: string | null;
}

/** A member's line in the list. `area` is the reverse-geocoded area, when the phone found one. */
export function presenceLine(
  member: Pick<FamilyMember, 'sharing' | 'location'>,
  places: readonly FamilyPlace[],
  area: string | null,
  now: number
): PresenceLine {
  if (!member.sharing) return { where: copy.status.sharingOff, when: null };
  const location = member.location;
  if (location === null) return { where: copy.status.noLocation, when: null };
  const when = freshness(location.updatedAt, now);
  const place = placeAt(location, places);
  if (place !== null) return { where: copy.status.atPlace(place.name), when };
  if (location.driving) return { where: copy.status.driving, when };
  return { where: area !== null ? copy.status.near(area) : copy.status.located, when };
}

/** A name to show for a member: their display name, or "You" / a neutral word when it is blank. */
export function memberName(member: Pick<FamilyMember, 'name' | 'isMe'>): string {
  if (member.isMe) return copy.home.you;
  return member.name.trim() === '' ? 'Family member' : member.name.trim();
}
