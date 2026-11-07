import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { useScoredDrives } from '@/data/queries/analytics';
import { useUnits } from '@/data/queries/units';
import { serverKey } from '@/data/server/useServerQuery';
import { deleteWrappedShare, SHARE_ID_RE, useMyWrapped, useSharedWrapped, useWrappedArchive, type WrappedCore } from '@/data/server/wrapped';
import { useSession } from '@/data/supabase/session';
import { usePlaces } from '@/features/places/usePlaces';
import { backOrHome, TopBar } from '@/features/settings/parts';
import { wrappedMonthHref } from '@/features/social/links';
import { formatDistance } from '@/lib/units';
import { Banner, Card, EmptyState, Screen, Skeleton, Text, useTheme, withAlpha } from '@/ui';

import { ArchetypeIcon } from './ArchetypeIcon';
import { archetypeName, archetypePattern, archetypeStops, SOFT_INK_ALPHA } from './archetypes';
import { wrappedCopy as copy } from './copy';
import { storySlides, type SlideId } from './format';
import { isMonth, monthName, monthYear } from './month';
import { wrappedPlaces, type WrappedPlaces } from './places';
import { shareWrapped } from './share';
import { slideNode, type StoryView } from './Slides';
import { SummaryCard } from './SummaryCard';
import { StoryButton, WrappedStory, type StorySlide } from './WrappedStory';

const WHITE = '#FFFFFF';
const SOFT = withAlpha(WHITE, SOFT_INK_ALPHA);
const DAY_MS = 86_400_000;

/**
 * The own story's Places, from this phone's scored drives of the month (read from two days before
 * the month's first UTC day, so no time zone misses its 1st) and the saved places; undefined while
 * either loads. Nothing here leaves the phone.
 */
export function useWrappedPlaces(month: string): WrappedPlaces | undefined {
  const valid = isMonth(month);
  const since = valid ? Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1) - 2 * DAY_MS : null;
  const drives = useScoredDrives(since);
  const { places, loading } = usePlaces();
  return useMemo(() => {
    if (!valid) return { pair: null, commuteDrives: 0 };
    // Another window's drives held over while this one loads say nothing about this month.
    if (drives.isPending || drives.isPlaceholderData || loading) return undefined;
    return wrappedPlaces(drives.data ?? [], month, places ?? []);
  }, [valid, drives.isPending, drives.isPlaceholderData, drives.data, loading, places, month]);
}

/** The card's width: as wide as the screen allows (24 pt each side) and short enough to leave room for the buttons. */
function useCardWidth(): number {
  const { width, height } = useWindowDimensions();
  return Math.max(160, Math.min(width - 48, ((height - 330) * 9) / 16, 320));
}

/**
 * The summary slide's share state. It lives in the screen, not the slide: the story mounts only the
 * slide on show, so a slide's own state would be lost on a step back and forward. `linked`: a link
 * to this month is known to be out (absent: the driver's own shared copy, `mine`, decides).
 */
type ShareState = { linked?: boolean; state: 'idle' | 'busy' | 'shared' | 'error' | 'stopped' | 'stopError' };
const SHARE_IDLE: ShareState = { state: 'idle' };

function SummarySlide({
  core,
  units,
  own,
  mine,
  share: shareState,
  setShare,
}: {
  core: WrappedCore;
  units: ReturnType<typeof useUnits>;
  own: boolean;
  mine: boolean;
  share: ShareState;
  setShare: (next: ShareState | ((s: ShareState) => ShareState)) => void;
}) {
  const t = useTheme();
  const card = useRef<View>(null);
  const width = useCardWidth();
  const client = useQueryClient();
  const { session } = useSession();
  const state = shareState.state;
  // A link to this month is known to be out: the driver's own shared copy, or one shared from here.
  const linked = shareState.linked ?? mine;
  const share = async () => {
    setShare((s) => ({ ...s, state: 'busy' }));
    try {
      await shareWrapped(card, core);
      setShare({ linked: true, state: 'shared' });
    } catch {
      setShare((s) => ({ ...s, state: 'error' }));
    }
  };
  const stop = async () => {
    setShare((s) => ({ ...s, state: 'busy' }));
    try {
      await deleteWrappedShare(core.month);
      setShare({ linked: false, state: 'stopped' });
      // Shared copies read as not available the next time they open. The one on screen (the driver's
      // own link) is not fetched again now, so it stays up with the "Sharing stopped" line.
      void client.invalidateQueries({ queryKey: serverKey(session?.user.id ?? null, 'wrapped', 'shared'), refetchType: mine ? 'none' : 'active' });
    } catch {
      setShare((s) => ({ ...s, state: 'stopError' }));
    }
  };
  const line = state === 'error' ? copy.summary.shareError : state === 'stopError' ? copy.summary.stopError : state === 'stopped' ? copy.summary.stopped : null;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.space.lg }}>
      <SummaryCard ref={card} core={core} units={units} width={width} />
      {own ? (
        <View style={{ alignSelf: 'stretch', flexDirection: 'row' }}>
          <StoryButton label={copy.summary.share} icon="share-outline" filled onPress={() => void share()} disabled={state === 'busy'} testID="wrapped-share" />
        </View>
      ) : mine ? null : (
        <Text variant="subhead" style={{ color: SOFT, textAlign: 'center' }} testID="wrapped-footer">
          {copy.summary.footer}
        </Text>
      )}
      {linked ? (
        <View style={{ alignSelf: 'stretch', flexDirection: 'row' }}>
          <StoryButton label={copy.summary.stopSharing} onPress={() => void stop()} disabled={state === 'busy'} testID="wrapped-stop-sharing" />
        </View>
      ) : null}
      {line ? (
        <Text variant="footnote" style={{ color: WHITE, textAlign: 'center' }} accessibilityLiveRegion="polite" testID="wrapped-share-line">
          {line}
        </Text>
      ) : null}
    </View>
  );
}

function buildSlides(ids: readonly SlideId[], view: StoryView, summary: ReactNode): StorySlide[] {
  return ids.map((id) => ({ id, node: id === 'summary' ? summary : slideNode(id, view) }));
}

function Waiting({ testID }: { testID: string }) {
  const th = useTheme();
  return (
    <Screen testID={testID}>
      <TopBar title={copy.archive.title} />
      <Skeleton width="100%" height={420} radius={th.radius.card} />
    </Screen>
  );
}

function Unavailable({ title, body, testID }: { title: string; body: string; testID: string }) {
  return (
    <Screen testID={testID}>
      <TopBar title={copy.archive.title} />
      <EmptyState icon="sparkles-outline" title={title} body={body} />
    </Screen>
  );
}

function LoadError({ onRetry, testID }: { onRetry: () => void; testID: string }) {
  return (
    <Screen testID={testID}>
      <TopBar title={copy.archive.title} />
      <Banner tone="danger" message={copy.loadError} action={{ label: copy.retry, onPress: onRetry }} />
    </Screen>
  );
}

/** `/wrapped/<YYYY-MM>`: the driver's own story of a past month (the push on the 1st opens last month's). */
export function WrappedMonthScreen({ month }: { month: string }) {
  const router = useRouter();
  const units = useUnits();
  const valid = isMonth(month);
  const q = useMyWrapped(month);
  const places = useWrappedPlaces(month);
  const [share, setShare] = useState<ShareState>(SHARE_IDLE);
  const name = monthName(month);

  if (!valid || q.data === null) return <Unavailable title={valid ? copy.noMonth(name) : copy.notAvailable} body={copy.noMonthBody} testID="wrapped-none" />;
  if (q.isError && !q.data) return <LoadError onRetry={() => void q.refetch()} testID="wrapped-error" />;
  if (!q.data || places === undefined) return <Waiting testID="wrapped-loading" />;

  const core = q.data;
  const view: StoryView = { kind: 'own', yours: true, core, own: core, badgesCount: core.badges.length, places, units, month: name };
  const ids = storySlides('own', { badges: core.badges.length, goals: core.goalsCompleted, places });
  return (
    <WrappedStory
      slides={buildSlides(ids, view, <SummarySlide core={core} units={units} own mine={false} share={share} setShare={setShare} />)}
      stops={archetypeStops(core.archetype)}
      header={copy.ownHeader(name)}
      onClose={() => backOrHome(router)}
    />
  );
}

/** `/w/<id>`: a shared Wrapped, for anyone signed in (not between drivers who blocked each other). */
export function SharedWrappedScreen({ id }: { id: string }) {
  const router = useRouter();
  const units = useUnits();
  const valid = SHARE_ID_RE.test(id);
  const q = useSharedWrapped(id);
  const [share, setShare] = useState<ShareState>(SHARE_IDLE);

  if (!valid || q.data === null) return <Unavailable title={copy.notAvailable} body={copy.notAvailableBody} testID="wrapped-unavailable" />;
  if (q.isError && !q.data) return <LoadError onRetry={() => void q.refetch()} testID="wrapped-error" />;
  if (!q.data) return <Waiting testID="wrapped-loading" />;

  const core = q.data;
  const name = monthName(core.month);
  const view: StoryView = { kind: 'shared', yours: core.mine, core, own: null, badgesCount: core.badgesCount, places: null, units, month: name };
  const ids = storySlides('shared', { badges: core.badgesCount, goals: 0, places: null });
  return (
    <WrappedStory
      slides={buildSlides(ids, view, <SummarySlide core={core} units={units} own={false} mine={core.mine} share={share} setShare={setShare} />)}
      stops={archetypeStops(core.archetype)}
      header={core.mine ? copy.ownHeader(name) : copy.sharedHeader(core.username, name)}
      onClose={() => backOrHome(router)}
    />
  );
}

/** `/wrapped`: every past Wrapped, newest first (Profile › Wrapped). */
export function WrappedArchiveScreen() {
  const th = useTheme();
  const router = useRouter();
  const units = useUnits();
  const q = useWrappedArchive();
  const list = q.data;
  return (
    <Screen scroll testID="wrapped-archive">
      <TopBar title={copy.archive.title} />
      {list ? (
        list.length === 0 ? (
          <EmptyState icon="sparkles-outline" title={copy.archive.title} body={copy.archive.empty} testID="wrapped-archive-empty" />
        ) : (
          list.map((e) => {
            const stops = archetypeStops(e.archetype);
            const name = archetypeName(e.archetype);
            return (
              <Card
                key={e.month}
                onPress={() => router.push(wrappedMonthHref(e.month))}
                accessibilityLabel={`${monthYear(e.month)}, ${name}`}
                testID={`wrapped-archive-${e.month}`}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
                  <ArchetypeIcon pattern={archetypePattern(e.archetype)} size={48} disc={stops[0]} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="headline">{monthYear(e.month)}</Text>
                    <Text variant="subhead" tone="muted">
                      {name}
                    </Text>
                  </View>
                  <Text variant="footnote" tone="muted">
                    {formatDistance(e.miles, units, { digits: 0 })}
                  </Text>
                </View>
              </Card>
            );
          })
        )
      ) : q.isError ? (
        <Banner tone="danger" message={copy.loadError} action={{ label: copy.retry, onPress: () => void q.refetch() }} testID="wrapped-archive-error" />
      ) : (
        <Skeleton width="100%" height={72} radius={th.radius.card} testID="wrapped-archive-loading" />
      )}
    </Screen>
  );
}
