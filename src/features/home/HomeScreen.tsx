/**
 * Home wired to its data: the server summary for the rating and the weekly goals, local drives for
 * the first-run gate, this week's pills, stats and recent drives, the coaching for the tip card,
 * whether drives start on their own for the words, and the drive controls for Start.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type ScrollView } from 'react-native';

import { DemoThemeLabel } from '@/demo/DemoThemeLabel'; // DEMO
import { DEMO_WARNING_ALERT, DEMO_WARNING_THEME, demoThemeOf, useDemo } from '@/demo/demoStore'; // DEMO
import { useDataSource, useDb, useDriveCount, useRecentDrives, useStatSums } from '@/data/queries';
import { useMySummary } from '@/data/server/summary';
import { clearDropNotice, isManualDrop, readDropNotice, type DropNotice } from '@/drive/dropNotice';
import { useDrive, useDriveControls } from '@/drive/useDrive';
import { useCoaching } from '@/features/analytics/useAnalytics';
import { autoDrivesOn, useAutoDrives } from '@/features/autoDrives/useAutoDrives';
import { DriveInProgressBanner } from '@/features/drive/DriveInProgressBanner';
import { sinceDays, weekStart } from '@/features/drives/format';
import { useDriveScores } from '@/features/drives/useDriveScores';
import { homeCard } from '@/features/permissions/board';
import { HomeDashpal } from '@/dashcam/ui/HomeDashpal';
import { PermissionCard } from '@/features/permissions/PermissionCard';
import { usePermissionBoard } from '@/features/permissions/usePermissionBoard';
import {
  ANALYTICS_HREF,
  DRIVE_HISTORY_HREF,
  DRIVE_HREF,
  driveSummaryHref,
  HOW_SCORES_WORK_HREF,
  PERMISSIONS_HREF,
  PROFILE_HREF,
} from '@/features/drives/routes';
import { useWeatherAlert } from '@/features/weather/useWeatherAlert';
import { WeatherAlertSlot } from '@/features/weather/HomeWeatherAlert';
import { Screen } from '@/ui';

import { homeCopy } from './copy';
import { clearHomeNotice, useHomeNotice } from './homeNotice';
import { HomeView } from './HomeView';
import { dropCopy, type StartRefusal } from './StartDrive';

/** Only a Start-card drive's drop is worth a line (`isManualDrop`): an automatic drive's says nothing. */
export { isManualDrop };

export function HomeScreen() {
  const router = useRouter();
  const { now } = useDataSource();
  const summary = useMySummary();
  const count = useDriveCount();
  const recent = useRecentDrives(5);
  const scores = useDriveScores(recent.data);
  const week = useStatSums(sinceDays(now(), 7));
  const month = useStatSums(sinceDays(now(), 30));
  const thisWeek = useStatSums(weekStart(now()));
  const { coaching } = useCoaching();
  const autoDrives = useAutoDrives();
  // Automatic drives switched off: Home never asks for Location Always or Background App Refresh.
  const autoDisabled = autoDrives.state === 'disabled';
  const { start } = useDriveControls();
  // One Open-Meteo reading feeds both the dangerous-weather card and the drive card's weather.
  const liveWeather = useWeatherAlert();
  // DEMO: the drive card's weather follows the demo theme, and the warning shows its alert.
  const demo = useDemo();
  const demoTheme = demoThemeOf(demo);
  const weather = {
    ...liveWeather,
    conditions: demoTheme?.conditions ?? liveWeather.conditions,
    ...(demo.weatherWarning ? { alert: DEMO_WARNING_ALERT, conditions: DEMO_WARNING_THEME.conditions } : {}),
  };
  // The status alone (not useDriveLive), so Home doesn't re-render on every 1 Hz drive tick: a
  // drive recording, or a Start waiting for the car to move.
  const recording = useDrive((d) => d.status === 'recording' || Boolean(d.waiting));
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  // The process-local line: a refusal from elsewhere (it outranks an older one), or that a drive
  // stopped from "Not driving?" won't count.
  const notice = useHomeNotice();
  const shownRefusal = notice !== null && notice !== 'notDriving' ? notice : refusal;
  // A drive that started any way takes an old refusal down.
  const [wasRecording, setWasRecording] = useState(recording);
  if (wasRecording !== recording) {
    setWasRecording(recording);
    if (recording) setRefusal(null);
  }

  // The notice of a drive that was not kept: read on focus and whenever a drive closes.
  const db = useDb();
  const lastFinalized = useDrive((d) => d.lastFinalized);
  const [dropped, setDropped] = useState<DropNotice | null>(null);
  const reloadDropped = useCallback(() => {
    let alive = true;
    readDropNotice(db)
      .then((n) => {
        if (alive) setDropped(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [db]);
  useFocusEffect(reloadDropped);
  useEffect(() => reloadDropped(), [reloadDropped, lastFinalized]);
  const dismissDropped = () => {
    setDropped(null);
    void clearDropNotice(db).catch(() => {});
  };

  // The permission card: whenever it has a row, Home opens at the top, so the driver sees it on
  // every visit (focus, a return to the front, or the row appearing while Home is in view).
  const board = usePermissionBoard();
  const scrollRef = useRef<ScrollView>(null);
  // Only a ready board (the phone read and the stored prefs both in), as the card itself shows.
  const hasRow = !recording && board.status === 'ready' && board.read !== null && homeCard(board.read, board.prefs, recording, autoDisabled).row !== null;
  const focused = useRef(false);
  const showsRow = useRef(hasRow);
  const toTop = useCallback(() => {
    if (focused.current && showsRow.current) scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);
  useEffect(() => {
    showsRow.current = hasRow;
    toTop();
  }, [hasRow, toTop]);
  const { refresh: refreshBoard } = board;
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      toTop();
      void refreshBoard('focus');
      return () => {
        focused.current = false;
      };
    }, [toTop, refreshBoard])
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') toTop();
    });
    return () => sub.remove();
  }, [toTop]);

  // Fix it on a refused Start: Precise Location and Location Services run that row's own fix (the
  // phone's dialog where it has one, otherwise its Settings page); anything else, or a fix that
  // could not run, opens Settings › Permissions.
  const onRefusalAction = async () => {
    if (shownRefusal === 'busy') {
      router.push(DRIVE_HREF);
      return;
    }
    if (shownRefusal === 'precise' || shownRefusal === 'services') {
      try {
        if ((await board.fix(shownRefusal === 'precise' ? 'precise' : 'location')) !== null) return;
      } catch {
        // The Permissions screen says where it stands.
      }
    }
    router.push(PERMISSIONS_HREF);
  };

  const onStart = async () => {
    if (starting) return;
    setStarting(true);
    setRefusal(null);
    clearHomeNotice();
    try {
      const res = await start();
      if (res.ok) {
        // The host clears the stored notice on a successful start.
        setDropped(null);
        router.push(DRIVE_HREF);
      } else setRefusal(res.reason);
    } catch {
      setRefusal('error');
    } finally {
      setStarting(false);
    }
  };

  // The "Not driving?" line comes first: it is the newest thing that happened.
  const infoLine =
    notice === 'notDriving'
      ? { message: homeCopy.notices.notDriving, onDismiss: clearHomeNotice, testID: 'not-driving-ack' }
      : dropped && isManualDrop(dropped)
        ? { message: dropCopy(dropped.cause, dropped.reason), onDismiss: dismissDropped }
        : null;

  const refreshing = summary.isRefetching || recent.isRefetching;
  // Pull to refresh also looks for a DashPal ready to pair (the slot counts the pulls).
  const [pulls, setPulls] = useState(0);

  return (
    <>
    <Screen padded={false} bottomInset={false} sky>
      <HomeView
        summary={summary.data}
        summaryLoading={summary.isLoading}
        summaryError={summary.isError}
        onRetrySummary={() => void summary.refetch()}
        driveCount={count.data}
        recent={recent.data}
        scores={scores}
        week={week.data}
        month={month.data}
        thisWeek={thisWeek.data}
        autoDrives={autoDrivesOn(autoDrives)}
        starting={starting}
        refusal={shownRefusal}
        dropNotice={infoLine}
        onStart={() => void onStart()}
        onRefusalAction={() => void onRefusalAction()}
        onOpenDrive={(id) => router.push(driveSummaryHref(id))}
        onSeeAll={() => router.push(DRIVE_HISTORY_HREF)}
        onAllStats={() => router.navigate(ANALYTICS_HREF)}
        onHowScores={() => router.push(HOW_SCORES_WORK_HREF)}
        onAnalytics={() => router.navigate(ANALYTICS_HREF)}
        onProfile={() => router.navigate(PROFILE_HREF)}
        recording={recording}
        inProgress={<DriveInProgressBanner />}
        weather={<WeatherAlertSlot feed={weather} />}
        conditions={weather.conditions}
        coaching={coaching}
        permissions={<PermissionCard board={board} recording={recording} autoDisabled={autoDisabled} onSeeAll={() => router.push(PERMISSIONS_HREF)} />}
        dashpal={<HomeDashpal hidden={recording} pull={pulls} />}
        scrollRef={scrollRef}
        refreshing={refreshing}
        onRefresh={() => {
          void summary.refetch();
          void count.refetch();
          void recent.refetch();
          void week.refetch();
          void month.refetch();
          void thisWeek.refetch();
          void board.refresh('shared');
          setPulls((n) => n + 1);
        }}
      />
    </Screen>
    <DemoThemeLabel />
    </>
  );
}
