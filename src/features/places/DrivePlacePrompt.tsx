import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { RowIcon } from '@/features/settings/parts';
import { Button, Card, Text, useTheme } from '@/ui';

import { placesCopy } from './copy';
import { declinePrompt, PROMPT_QUERY, useDrivePrompt, type DrivePrompt } from './drivePrompt';
import { FIXED_NAME, PROMPT_OFF_KEY } from './model';
import { addressAt } from './search';
import { usePlaces } from './usePlaces';

const copy = placesCopy.prompt;

const ICON = { home: 'home-outline', work: 'briefcase-outline', school: 'school-outline' } as const;

/** Why it asks, in a few words. */
export function promptWhy(p: Pick<DrivePrompt, 'kind' | 'why'>): string {
  return p.why === 'name' && p.kind === 'work' ? copy.whyWork : copy.why[p.why];
}

/**
 * The recap's small card under the map: "Save as Home?" with the address and why, then Yes, No and
 * Don't remind me. Shown only when this drive's end (or start) is surely Home, Work or School
 * (`drivePrompt.ts`); nothing otherwise. Yes saves the place (Settings › Places), No never asks
 * about that spot again, Don't remind me turns the question off (back on from Places).
 */
export function DrivePlacePrompt({ clientTripId }: { clientTripId: string }) {
  const th = useTheme();
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const prompt = useDrivePrompt(clientTripId);
  const { save } = usePlaces();
  const [state, setState] = useState<'ask' | 'busy' | 'saved' | 'gone' | 'failed'>('ask');

  const p = prompt.data;
  if (!p || state === 'gone') return null;
  const name = FIXED_NAME[p.kind];

  if (state === 'saved') {
    return (
      <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite" testID="drive-place-saved">
        {copy.saved(name)}
      </Text>
    );
  }

  const settle = () => void client.invalidateQueries({ queryKey: PROMPT_QUERY });

  const yes = async () => {
    setState('busy');
    // Inside a zone (never looked up on its own) or unnamed: the driver said Yes, so name it now.
    const lines = p.address ?? (await addressAt(p.point));
    const ok = await save({ id: p.kind, kind: p.kind, name, address: lines?.title ?? copy.unnamed, area: lines?.subtitle ?? '', lat: p.point.lat, lng: p.point.lng });
    setState(ok ? 'saved' : 'failed');
  };

  const no = () => {
    setState('gone');
    void declinePrompt(settings, p.point)
      .catch(() => {})
      .finally(settle);
  };

  const never = () => {
    setState('gone');
    void settings
      .set(PROMPT_OFF_KEY, true)
      .catch(() => {})
      .finally(settle);
  };

  const place = p.address ? p.address.title : p.zone ? copy.inZone(p.zone.name) : null;
  const line = [place, promptWhy(p)].filter((s): s is string => s !== null && s !== '').join(' · ');

  return (
    <Card padded={false} testID="drive-place-prompt">
      <View style={{ padding: th.space.md, gap: th.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
          <RowIcon name={ICON[p.kind]} />
          <View style={{ flex: 1 }}>
            <Text variant="headline">{copy.title(p.kind)}</Text>
            <Text variant="footnote" tone="muted" numberOfLines={1}>
              {line}
            </Text>
          </View>
        </View>
        {state === 'failed' ? (
          <Text variant="footnote" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
          <Button label={copy.yes} size="sm" onPress={() => void yes()} loading={state === 'busy'} testID="drive-place-yes" />
          <Button label={copy.no} size="sm" variant="secondary" onPress={no} disabled={state === 'busy'} testID="drive-place-no" />
          <View style={{ flex: 1 }} />
          <Button label={copy.never} size="sm" variant="ghost" onPress={never} disabled={state === 'busy'} testID="drive-place-never" />
        </View>
      </View>
    </Card>
  );
}
