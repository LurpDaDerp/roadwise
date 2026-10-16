/**
 * Home's permission card: one small row for the first permission that is off and in use, under
 * the greeting, and a quieter "N more · See all" line when others are off too. A tap asks the
 * phone ("Allow") or opens its Settings ("Open Settings"). A right-to-left swipe, a long press or
 * the screen reader's "Don't remind me again" action asks to hide that row; confirming hides it
 * until Show on Home in Settings › Permissions, and the next row takes its place. Nothing shows
 * while the board loads, can't be read, or a drive records.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Pressable, View, type AccessibilityActionEvent } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';

import { Card, Divider, Text, useTheme } from '@/ui';

import { fixFor, homeCard, type BoardRow } from './board';
import { homeLine, permissionName, permissionsCopy, type CopyCtx } from './copy';
import type { PermissionBoardRead } from './registry';
import type { PermissionBoard } from './usePermissionBoard';

const copy = permissionsCopy.home;

/** The swipe panel's width, and how far a drag must go to open it (0.6 of it, so a clamped drag always gets there). */
export const SWIPE_PANEL_W = 120;
export const SWIPE_THRESHOLD = 72;
export const LONG_PRESS_MS = 500;

export function PermissionCard({ board, recording, onSeeAll }: { board: PermissionBoard; recording: boolean; onSeeAll: () => void }) {
  const read = board.status === 'ready' ? board.read : null;
  if (read === null || recording) return null;
  const card = homeCard(read, board.prefs, recording);
  if (card.row === null) return null;
  return <PermissionCardBody board={board} read={read} row={card.row} more={card.more} onSeeAll={onSeeAll} />;
}

function PermissionCardBody({ board, read, row, more, onSeeAll }: { board: PermissionBoard; read: PermissionBoardRead; row: BoardRow; more: number; onSeeAll: () => void }) {
  const t = useTheme();
  const ctx: CopyCtx = { platform: read.snapshot.platform, androidApi: read.androidApi };
  return (
    <Card padded={false} testID="home-permissions">
      <Animated.View
        key={row.id}
        exiting={t.reduceMotion ? undefined : FadeOut.duration(150)}
        layout={t.reduceMotion ? undefined : LinearTransition}
      >
        <PermissionRow board={board} read={read} row={row} ctx={ctx} />
      </Animated.View>
      {more > 0 ? (
        <>
          <Divider inset={16} />
          <Pressable
            onPress={onSeeAll}
            accessibilityRole="link"
            accessibilityLabel={copy.moreLabel(more)}
            testID="home-permissions-more"
            style={({ pressed }) => ({
              minHeight: 44,
              paddingHorizontal: t.space.lg,
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.space.sm,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
              {copy.more(more)}
            </Text>
            <Text variant="footnote" style={{ color: t.colors.accent, fontWeight: '600' }}>
              {copy.seeAll}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={t.colors.accent} />
          </Pressable>
        </>
      ) : null}
    </Card>
  );
}

function PermissionRow({ board, read, row, ctx }: { board: PermissionBoard; read: PermissionBoardRead; row: BoardRow; ctx: CopyCtx }) {
  const t = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  const [busy, setBusy] = useState(false);
  // The read a failure happened on: its line stands until the next read or tap.
  const [failedOn, setFailedOn] = useState<PermissionBoardRead | null>(null);
  const confirming = useRef(false);

  if (row.state.kind !== 'missing') return null;
  const state = row.state;
  const fix = fixFor(row.id, state, board.prefs) ?? 'settings';
  const action = fix === 'request' ? copy.allow : copy.openSettings;
  const failed = failedOn !== null && failedOn === read;
  const line = failed ? permissionsCopy.actionError : homeLine(row.id, state, ctx);
  const required = row.def.need === 'required';

  const fail = () => {
    setFailedOn(read);
    AccessibilityInfo.announceForAccessibility(permissionsCopy.actionError);
  };

  const onTap = async () => {
    if (busy) return;
    setBusy(true);
    setFailedOn(null);
    try {
      await board.fix(row.id);
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    confirming.current = false;
    swipe.current?.close();
  };

  const hide = async () => {
    confirming.current = false;
    try {
      await board.hide(row.id);
    } catch {
      swipe.current?.close();
      fail();
    }
  };

  const confirm = () => {
    if (busy || confirming.current) return;
    confirming.current = true;
    Alert.alert(
      copy.confirmTitle,
      copy.confirmMessage(permissionName(row.id, ctx)),
      [
        { text: copy.cancel, style: 'cancel', onPress: close },
        { text: copy.confirm, style: 'destructive', onPress: () => void hide() },
      ],
      { cancelable: true, onDismiss: close }
    );
  };

  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'activate') void onTap();
    else if (e.nativeEvent.actionName === 'dismiss') confirm();
  };

  return (
    <ReanimatedSwipeable
      ref={swipe}
      enabled={!busy}
      friction={1.5}
      rightThreshold={SWIPE_THRESHOLD}
      overshootRight={false}
      onSwipeableOpen={confirm}
      renderRightActions={() => (
        <View
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={{
            width: SWIPE_PANEL_W,
            backgroundColor: t.colors.surfaceRaised,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            paddingHorizontal: t.space.sm,
          }}
          testID="home-permission-swipe-panel"
        >
          <Ionicons name="eye-off-outline" size={18} color={t.colors.textMuted} />
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {copy.swipe}
          </Text>
        </View>
      )}
      testID="home-permission-swipe"
    >
      <Pressable
        onPress={() => void onTap()}
        onLongPress={confirm}
        delayLongPress={LONG_PRESS_MS}
        accessibilityRole="button"
        accessibilityLabel={`${line} ${action}.`}
        accessibilityState={{ busy }}
        accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: copy.dismissAction }]}
        onAccessibilityAction={onAction}
        testID={`home-permission-${row.id}`}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingVertical: 10,
          paddingHorizontal: t.space.lg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.md,
          backgroundColor: t.colors.surface,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Ionicons
          name={required ? 'alert-circle' : 'alert-circle-outline'}
          size={18}
          color={required ? t.colors.danger : t.colors.warning}
        />
        <Text variant="subhead" numberOfLines={2} style={{ flex: 1 }} testID="home-permission-line">
          {line}
        </Text>
        {busy ? (
          <ActivityIndicator size="small" color={t.colors.accent} testID="home-permission-busy" />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Text variant="footnote" style={{ color: t.colors.accent, fontWeight: '600' }} testID="home-permission-action">
              {action}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={t.colors.accent} />
          </View>
        )}
      </Pressable>
    </ReanimatedSwipeable>
  );
}
