import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { AIM_STALE_MS, aimLevel, aimLine, createAimAnnouncer, createGoodLatch } from '../../aim';
import { dashpalCopy } from '../../copy';
import type { AimFrame } from '../../protocol';
import type { AimStatus, SetupFlow } from '../../setup';
import { jpegDataUri } from '../../view';
import { AimBorder } from './AimBorder';
import { announce } from './StepTitle';

const copy = dashpalCopy.wizard.aim;

/** How often the screen looks whether its AIM reading went stale. */
export const AIM_STALE_CHECK_MS = 250;

/**
 * The two picture layers: an image loads in the back one, which becomes the front once loaded. While
 * the back one is still loading, the newest image waits in `next` (replacing an older one waiting
 * there) and loads once the back one is shown, so a phone that decodes slower than images arrive
 * still shows a new picture each time one has loaded.
 */
interface Layers {
  a: string | null;
  b: string | null;
  front: 'a' | 'b';
  loading: boolean;
  next: string | null;
}
const EMPTY: Layers = { a: null, b: null, front: 'a', loading: false, next: null };
const backOf = (l: Layers): 'a' | 'b' => (l.front === 'a' ? 'b' : 'a');

/**
 * A new image: into the back layer, or to wait while the back layer is still loading. The same
 * picture as the front one changes nothing, and the one the back layer already holds is shown at
 * once (an unchanged source would never report a load).
 */
function layersWithImage(l: Layers, uri: string): Layers {
  if (l.loading) return { ...l, next: uri };
  if (uri === l[l.front]) return l;
  const back = backOf(l);
  if (l[back] === uri) return { ...l, front: back };
  return { ...l, [back]: uri, loading: true };
}

/** The back layer finished (loaded, or failed: then it is not shown); the waiting image loads next. */
function layersSettled(l: Layers, key: 'a' | 'b', uri: string, loaded: boolean): Layers {
  if (key !== backOf(l) || l[key] !== uri || !l.loading) return l;
  const shown: Layers = loaded ? { ...l, front: key, loading: false } : { ...l, loading: false };
  if (shown.next === null) return shown;
  return layersWithImage({ ...shown, next: null }, shown.next);
}

/** RoadWise is not in the front (the app switcher, a call, the home screen). */
const away = (s: string | null | undefined): boolean => s === 'inactive' || s === 'background';

/**
 * Screen 3's picture: what DashPal's camera sees, small, grey and a few frames a second, shown as a
 * mirror in a 4:3 box, with no box or mark on the face. Its frame is coloured by DashPal's aim score
 * (`AimBorder`), "Good position" with a check (and a success haptic) once the aim has held good for
 * a second, and the hint line under it says what to change; a screen reader hears the line once it
 * has held. Images come from `flow.onViewFrame` and stay in this component's memory only (the
 * newest one, loaded with no cache); RoadWise leaving the front covers the picture and drops it in
 * the same render, before the system takes its snapshot.
 */
export function AimView({ flow, status }: { flow: Pick<SetupFlow, 'onViewFrame' | 'onAim'>; status: AimStatus }) {
  const th = useTheme();
  const [layers, setLayers] = useState<Layers>(EMPTY);
  const [aim, setAim] = useState<AimFrame | null>(null);
  const [good, setGood] = useState(false);
  const [covered, setCovered] = useState(away(AppState.currentState));
  const lastAimAt = useRef(0);
  const latch = useRef(createGoodLatch());
  const announcer = useRef(createAimAnnouncer());

  // The images: each goes to the back layer, or waits there while the back one is still loading.
  useEffect(
    () =>
      flow.onViewFrame((jpeg) => {
        const uri = jpegDataUri(jpeg);
        setLayers((l) => layersWithImage(l, uri));
      }),
    [flow]
  );

  // The AIM frames: the border, the latch (with its haptic), the line and what a screen reader hears.
  useEffect(
    () =>
      flow.onAim((a) => {
        const at = Date.now();
        lastAimAt.current = a ? at : 0;
        const was = latch.current.good();
        const now = latch.current.push(a ? a.score : null, at);
        setAim(a);
        setGood(now);
        if (now && !was) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (a) {
          const said = announcer.current.next(aimLine(a), now && !was, at);
          if (said) announce(said);
        }
      }),
    [flow]
  );

  // No AIM for a second: no reading (a neutral frame, "Waiting for the picture…", no verdict).
  useEffect(() => {
    if (!aim) return;
    const timer = setInterval(() => {
      if (Date.now() - lastAimAt.current < AIM_STALE_MS) return;
      latch.current.push(null, Date.now());
      setAim(null);
      setGood(false);
    }, AIM_STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, [aim]);

  // RoadWise leaving the front: covered and the images dropped in one render.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      const gone = away(s);
      setCovered(gone);
      if (gone) {
        setLayers(EMPTY);
        setAim(null);
        setGood(false);
      }
    });
    return () => sub.remove();
  }, []);

  // A refused picture, or one starting again, leaves no image behind.
  const [seenStatus, setSeenStatus] = useState(status);
  if (seenStatus !== status) {
    setSeenStatus(status);
    if (status === 'refused' || status === 'starting') setLayers(EMPTY);
  }

  const live = status === 'live' || status === 'stalled';
  const fresh = live ? aim : null;
  const line = status === 'starting' ? copy.starting : status === 'stalled' ? copy.stalled : aimLine(fresh);
  const layer = (key: 'a' | 'b') => {
    const uri = layers[key];
    if (uri === null) return null;
    const isFront = key === layers.front;
    return (
      <Image
        key={key}
        source={{ uri }}
        cachePolicy="none"
        transition={0}
        contentFit="cover"
        onLoad={() => setLayers((l) => layersSettled(l, key, uri, true))}
        onError={() => setLayers((l) => layersSettled(l, key, uri, false))}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: isFront ? (status === 'stalled' ? 0.5 : 1) : 0, transform: [{ scaleX: -1 }] }}
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID={`aim-layer-${key}`}
      />
    );
  };

  return (
    <View style={{ gap: th.space.md }}>
      <AimBorder level={fresh ? aimLevel(fresh.score) : null} good={good && fresh !== null}>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={copy.videoLabel}
          accessibilityValue={{ text: line }}
          style={{ width: '100%', aspectRatio: 4 / 3, backgroundColor: '#000000' }}
          testID="aim-video"
        >
          {covered ? null : (
            <>
              {layer('a')}
              {layer('b')}
            </>
          )}
          {status === 'starting' && !covered ? (
            <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color="#FFFFFF" testID="aim-spinner" />
            </View>
          ) : null}
          {good && fresh !== null && !covered ? (
            <View
              style={{
                position: 'absolute',
                top: th.space.sm,
                right: th.space.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: th.space.xs,
                paddingHorizontal: th.space.sm,
                paddingVertical: th.space.xs,
                borderRadius: th.radius.pill,
                backgroundColor: 'rgba(0, 0, 0, 0.6)',
              }}
              testID="aim-good"
            >
              <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" />
              <Text variant="footnote" style={{ color: '#FFFFFF' }}>
                {copy.good}
              </Text>
            </View>
          ) : null}
          {covered ? <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000000' }} testID="aim-cover" /> : null}
        </View>
      </AimBorder>
      {status === 'refused' ? null : (
        // Said through the announcer (once held, rate-limited), not a live region that would say every change.
        <Text variant="callout" testID="aim-hint" style={{ minHeight: 44 }}>
          {line}
        </Text>
      )}
    </View>
  );
}
