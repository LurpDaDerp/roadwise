/**
 * Home wired to its data: the server summary for the header and challenges, local drives for
 * the first-run gate, stats and recent drives, and the drive controls for Start.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type ScrollView } from 'react-native';

import { useDataSource, useDb, useDriveCount, useRecentDrives, useStatSums } from '@/data/queries';
import { useMySummary } from '@/data/server/summary';
import { clearDropNotice, readDropNotice, type DropNotice } from '@/drive/dropNotice';
import { useDrive, useDriveControls } from '@/drive/useDrive';
import { DriveInProgressBanner } from '@/features/drive/DriveInProgressBanner';
import { sinceDays } from '@/features/drives/format';
import { homeCard } from '@/features/permissions/board';
import { PermissionCard } from '@/features/permissions/PermissionCard';
import { usePermissionBoard } from '@/features/permissions/usePermissionBoard';
import {
  ALL_STATS_HREF,
  DRIVE_HISTORY_HREF,
  DRIVE_HREF,
  driveSummaryHref,
  HOW_POINTS_WORK_HREF,
  LEAGUES_HREF,
  PERMISSIONS_HREF,
} from '@/features/drives/routes';
import { Screen } from '@/ui';

import { HomeView } from './HomeView';
import { dropCopy, type StartBanner } from './StartDrive';
import { clearStartNotice, useStartNotice } from './startNotice';

export function HomeScreen() {
  const router = useRouter();
  const { now } = useDataSource();
  const summary = useMySummary();
  const count = useDriveCount();
  const recent = useRecentDrives(5);
  const week = useStatSums(sinceDays(now(), 7));
  const month = useStatSums(sinceDays(now(), 30));
  const { start } = useDriveControls();
  // The status alone (not useDriveLive), so Home doesn't re-render on every 1 Hz drive tick.
  const recording = useDrive((d) => d.status === 'recording');
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<StartBanner | null>(null);
  // Why a tap on the forgot-to-start reminder started no drive: shown in the same line as a refused
  // Start (it outranks an older one), until the next start.
  const notice = useStartNotice();
  const shownRefusal = notice ?? refusal;
  // A drive that started any way (a tap on the reminder too) takes an old refusal down.
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
  const hasRow = !recording && board.read !== null && homeCard(board.read, board.prefs, recording).row !== null;
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

  const onStart = async () => {
    if (starting) return;
    setStarting(true);
    setRefusal(null);
    clearStartNotice();
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

  const refreshing = summary.isRefetching || recent.isRefetching;

  return (
    <Screen padded={false} bottomInset={false}>
      <HomeView
        summary={summary.data}
        summaryLoading={summary.isLoading}
        summaryError={summary.isError}
        onRetrySummary={() => void summary.refetch()}
        driveCount={count.data}
        recent={recent.data}
        week={week.data}
        month={month.data}
        starting={starting}
        refusal={shownRefusal}
        dropNotice={dropped ? { message: dropCopy(dropped.cause, dropped.reason), onDismiss: dismissDropped } : null}
        onStart={() => void onStart()}
        onRefusalAction={() => (shownRefusal === 'permission' ? router.push(PERMISSIONS_HREF) : router.push(DRIVE_HREF))}
        onOpenDrive={(id) => router.push(driveSummaryHref(id))}
        onSeeAll={() => router.push(DRIVE_HISTORY_HREF)}
        onAllStats={() => router.push(ALL_STATS_HREF)}
        onHowPoints={() => router.push(HOW_POINTS_WORK_HREF)}
        onLeagues={() => router.navigate(LEAGUES_HREF)}
        recording={recording}
        inProgress={<DriveInProgressBanner />}
        permissions={<PermissionCard board={board} recording={recording} onSeeAll={() => router.push(PERMISSIONS_HREF)} />}
        scrollRef={scrollRef}
        refreshing={refreshing}
        onRefresh={() => {
          void summary.refetch();
          void count.refetch();
          void recent.refetch();
          void week.refetch();
          void month.refetch();
          void board.refresh('shared');
        }}
      />
    </Screen>
  );
}
