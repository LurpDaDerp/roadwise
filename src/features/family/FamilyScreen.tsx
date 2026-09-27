import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Switch, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { recordConsent } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { Banner, Button, ListRow, Screen, Skeleton, Text, useTheme } from '@/ui';

import type { Family, FamilyMember, FamilyPlace } from './api';
import { familyCopy as copy } from './copy';
import { acceptFamilyDisclosure, familyDisclosureWords, type RecordFamilyConsent } from './disclosure';
import { FamilyMap } from './FamilyMap';
import { FamilyStart } from './FamilyStart';
import { errorText, useArea, type ReverseGeocode } from './parts';
import { memberName, presenceLine } from './presence';
import { useFamily, useFamilyActions, type FamilyDeps } from './useFamily';

export const FAMILY_MANAGE_HREF = '/family/manage' as Href;
export const familyPlaceHref = (id?: string) => (id === undefined ? '/family/place' : `/family/place?id=${id}`) as Href;

export interface FamilyScreenDeps extends FamilyDeps {
  now?: () => number;
  reverseGeocode?: ReverseGeocode;
  /** The confirmation dialog (default React Native `Alert.alert`). */
  alert?: typeof Alert.alert;
  /** Records the pd-2 consent when sharing is turned on (default `recordConsent`). */
  recordConsent?: RecordFamilyConsent;
}

/** Polls while the screen is focused; stops the moment it is not. */
function useFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );
  return focused;
}

/**
 * The Family tab. Without a family: what it is for, and join or start one. With one: the map, the
 * caller's own sharing switch, where each member is (in words, with how long ago), the family's
 * places, and the family settings.
 */
export function FamilyScreen({ deps = {} }: { deps?: FamilyScreenDeps }) {
  const focused = useFocused();
  const family = useFamily({ ...deps, poll: focused });
  const th = useTheme();

  let body;
  if (family.data === undefined && family.isError) {
    body = (
      <Banner
        testID="family-error"
        tone="danger"
        message={errorText(family.error)}
        action={{ label: copy.retry, onPress: () => void family.refetch() }}
      />
    );
  } else if (family.data === undefined) {
    body = (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID="family-loading" style={{ gap: th.space.md }}>
        <Skeleton width="60%" height={20} />
        <Skeleton width="100%" height={180} />
        <Skeleton width="80%" height={20} />
      </View>
    );
  } else if (family.data.family === null) {
    body = (
      <View style={{ gap: th.space.lg }}>
        <Text variant="body">{copy.start.explainer}</Text>
        <FamilyStart deps={deps} />
      </View>
    );
  } else {
    body = <FamilyHome family={family.data.family} deps={deps} />;
  }

  return (
    <Screen scroll bottomInset={false} testID="family-screen">
      <Text variant="title1" accessibilityRole="header">
        {family.data?.family?.name ?? copy.tabTitle}
      </Text>
      {body}
    </Screen>
  );
}

function FamilyHome({ family, deps }: { family: Family; deps: FamilyScreenDeps }) {
  const th = useTheme();
  const router = useRouter();
  const now = (deps.now ?? Date.now)();
  const others = family.members.filter((m) => !m.isMe);
  const me = family.members.find((m) => m.isMe);
  return (
    <View style={{ gap: th.space.lg }}>
      <FamilyMap members={family.members} places={family.places} />
      <SharingSwitch on={family.mySharing} deps={deps} />
      <View style={{ gap: th.space.xs }}>
        <Text variant="headline" accessibilityRole="header">
          {copy.home.members}
        </Text>
        {[...(me ? [me] : []), ...others].map((m) => (
          <MemberRow key={m.userId} member={m} places={family.places} now={now} reverse={deps.reverseGeocode ?? null} />
        ))}
      </View>
      <View style={{ gap: th.space.xs }}>
        <Text variant="headline" accessibilityRole="header">
          {copy.home.places}
        </Text>
        {family.places.length === 0 ? (
          <Text variant="subhead" tone="muted" testID="family-no-places">
            {copy.home.noPlaces}
          </Text>
        ) : (
          family.places.map((p) => <PlaceRow key={p.id} place={p} onPress={() => router.push(familyPlaceHref(p.id))} />)
        )}
        <Button
          label={copy.home.addPlace}
          variant="ghost"
          size="md"
          icon={<Ionicons name="add" size={20} color={th.colors.accent} />}
          onPress={() => router.push(familyPlaceHref())}
          disabled={family.places.length >= 20}
          testID="family-add-place"
        />
      </View>
      <Button label={copy.home.manage} variant="secondary" onPress={() => router.push(FAMILY_MANAGE_HREF)} testID="family-manage" />
    </View>
  );
}

function MemberRow({
  member,
  places,
  now,
  reverse,
}: {
  member: FamilyMember;
  places: readonly FamilyPlace[];
  now: number;
  reverse: ReverseGeocode | null;
}) {
  const area = useArea(member.sharing ? member.location : null, reverse);
  const line = presenceLine(member, places, area, now);
  const name = memberName(member);
  const subtitle = line.when === null ? line.where : `${line.where} · ${line.when}`;
  return (
    <ListRow
      title={member.role === 'admin' ? `${name} · ${copy.home.admin}` : name}
      subtitle={subtitle}
      accessory="none"
      accessibilityLabel={`${name}${member.role === 'admin' ? `, ${copy.home.admin}` : ''}. ${subtitle}`}
      testID={`family-member-${member.userId}`}
    />
  );
}

function PlaceRow({ place, onPress }: { place: FamilyPlace; onPress: () => void }) {
  return (
    <ListRow
      title={place.name}
      subtitle={place.address === '' ? undefined : place.address}
      onPress={onPress}
      accessory="chevron"
      testID={`family-place-${place.id}`}
    />
  );
}

/**
 * "Share my location": asks before turning on (who will see what) and before turning off (the last
 * location is deleted), in both directions, and shows the server's answer, not the tap. Turning on
 * shows the background-location disclosure's words for family sharing (pd-2: only its new words to
 * an account that accepted pd-1, all of it otherwise), and confirming records that acceptance, the
 * consent the server requires, before sharing is turned on.
 */
function SharingSwitch({ on, deps }: { on: boolean; deps: FamilyScreenDeps }) {
  const th = useTheme();
  const actions = useFamilyActions(deps);
  const [error, setError] = useState<string | null>(null);
  // The answer being sent, shown until the refreshed snapshot (awaited by the hook) says the same.
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? on;
  const alert = deps.alert ?? Alert.alert;
  const { db } = useDataSource();
  const uid = useSession().session?.user.id ?? null;

  const send = (next: boolean) =>
    actions.setSharing.mutate(next, {
      onError: (e) => setError(errorText(e)),
      onSettled: () => setPending(null),
    });

  const turnOn = async () => {
    if (uid === null) return;
    const disclosure = await familyDisclosureWords(db, uid).catch(() => null);
    if (disclosure === null) {
      setError(copy.errors.unknown);
      return;
    }
    const words = copy.confirmShareOn;
    alert(words.title, words.withDisclosure(words.body, disclosure), [
      { text: words.cancel, style: 'cancel' },
      {
        text: words.confirm,
        onPress: () => {
          setError(null);
          setPending(true);
          acceptFamilyDisclosure(db, uid, (deps.now ?? Date.now)(), deps.recordConsent ?? recordConsent).then(
            () => send(true),
            () => {
              setPending(null);
              setError(words.consentFailed);
            }
          );
        },
      },
    ]);
  };

  const turnOff = () => {
    const words = copy.confirmShareOff;
    alert(words.title, words.body, [
      { text: words.cancel, style: 'cancel' },
      {
        text: words.confirm,
        style: 'destructive',
        onPress: () => {
          setError(null);
          setPending(false);
          send(false);
        },
      },
    ]);
  };

  const change = (next: boolean) => {
    if (next) void turnOn();
    else turnOff();
  };

  return (
    <View style={{ gap: th.space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{copy.home.mySharingTitle}</Text>
          <Text variant="subhead" tone="muted" testID="family-sharing-hint">
            {shown ? copy.home.mySharingOn : copy.home.mySharingOff}
          </Text>
        </View>
        <Switch
          testID="family-sharing"
          accessibilityLabel={copy.home.mySharingTitle}
          value={shown}
          disabled={actions.setSharing.isPending}
          onValueChange={change}
          trackColor={{ true: th.colors.accent, false: th.colors.borderStrong }}
        />
      </View>
      {error ? <Banner tone="danger" message={error} testID="family-sharing-error" /> : null}
    </View>
  );
}
