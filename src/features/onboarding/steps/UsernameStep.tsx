import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { callRpc } from '@/data/server/rpc';
import { useSession } from '@/data/supabase/session';
import { friendlyError } from '@/features/social/errors';
import { Avatar, Text, useFontScale, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.username;

export type UsernameReason = keyof typeof copy.reasons;

export type UsernameCheck =
  | { state: 'empty' }
  | { state: 'invalid'; reason: 'length' | 'characters' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: UsernameReason }
  | { state: 'error'; message: string };

/** What can be said about a name without asking the server. Null: ask the server. */
export function localCheck(name: string): UsernameCheck | null {
  if (name.length === 0) return { state: 'empty' };
  if (!/^[a-z0-9_]+$/.test(name)) return { state: 'invalid', reason: 'characters' };
  if (name.length < 3 || name.length > 20) return { state: 'invalid', reason: 'length' };
  return null;
}

/** Typing normalised the way the server stores it: lower-case, no spaces. */
export const normaliseUsername = (text: string) => text.toLowerCase().replace(/\s+/g, '');

export const USERNAME_DEBOUNCE_MS = 400;

/**
 * Pick a username: checked live (`check_username`, debounced) with a friendly reason when it can't
 * be had, then claimed (`claim_username`). The profile is refreshed before moving on, so the flow
 * drops this step and Back can never return to it.
 */
export function UsernameStep({ onNext, debounceMs = USERNAME_DEBOUNCE_MS }: StepProps & { debounceMs?: number }) {
  const th = useTheme();
  const scale = useFontScale();
  const { refreshProfile } = useSession();
  const [name, setName] = useState('');
  /** The server's answer, for the name it was asked about. */
  const [remote, setRemote] = useState<{ name: string; check: UsernameCheck } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const ticket = useRef(0);

  const local = localCheck(name);
  const check: UsernameCheck = local ?? (remote?.name === name ? remote.check : { state: 'checking' });

  useEffect(() => {
    const mine = ++ticket.current;
    if (localCheck(name)) return;
    const timer = setTimeout(() => {
      callRpc<{ available: boolean; reason: UsernameReason | null }>('check_username', { p: name })
        .then((r) => {
          if (mine !== ticket.current) return;
          setRemote({ name, check: r.available ? { state: 'available' } : { state: 'unavailable', reason: r.reason ?? 'taken' } });
        })
        .catch((e: unknown) => {
          if (mine === ticket.current) setRemote({ name, check: { state: 'error', message: friendlyError(e) } });
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [name, debounceMs]);

  const claim = async () => {
    if (check.state !== 'available' || claiming) return;
    setClaiming(true);
    setClaimError(null);
    try {
      await callRpc<null>('claim_username', { p: name });
      await refreshProfile();
      onNext();
    } catch (e) {
      setClaimError(friendlyError(e));
      setClaiming(false);
    }
  };

  const status = statusLine(check, name);
  const ink =
    status?.tone === 'ok' ? th.colors.success : status?.tone === 'bad' ? th.colors.danger : th.colors.textMuted;
  const glyph = status?.tone === 'ok' ? 'checkmark-circle' : status?.tone === 'bad' ? 'close-circle' : 'ellipsis-horizontal-circle';

  return (
    <StepFrame
      title={copy.title}
      body={copy.body}
      primary={{
        label: copy.claim,
        onPress: () => void claim(),
        disabled: check.state !== 'available',
        loading: claiming,
        testID: 'username-claim',
      }}
      testID="username-step"
    >
      <View style={{ gap: th.space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
          <Avatar username={name.length > 0 ? name : '?'} size="lg" />
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: 52 * scale,
              borderWidth: 2,
              borderColor: status?.tone === 'ok' ? th.colors.success : status?.tone === 'bad' ? th.colors.danger : th.colors.borderStrong,
              borderRadius: th.radius.md,
              borderCurve: 'continuous',
              backgroundColor: th.colors.surface,
              paddingHorizontal: th.space.md,
            }}
          >
            <Text variant="title3" tone="muted" accessibilityElementsHidden importantForAccessibility="no">
              @
            </Text>
            <TextInput
              testID="username-input"
              accessibilityLabel={copy.label}
              accessibilityHint={copy.rules}
              value={name}
              onChangeText={(t) => {
                setClaimError(null);
                setName(normaliseUsername(t));
              }}
              placeholder={copy.placeholder}
              placeholderTextColor={th.colors.textSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              allowFontScaling={false}
              returnKeyType="done"
              onSubmitEditing={() => void claim()}
              style={{ flex: 1, color: th.colors.text, fontSize: 20 * scale, fontWeight: '600', paddingVertical: th.space.sm }}
            />
          </View>
        </View>
        {status ? (
          <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }} accessibilityLiveRegion="polite">
            <Ionicons name={glyph} size={20 * Math.min(scale, 2)} color={ink} accessibilityElementsHidden importantForAccessibility="no" />
            <Text variant="callout" style={{ flex: 1 }} testID="username-status">
              {status.text}
            </Text>
          </View>
        ) : (
          <Text variant="footnote" tone="muted" testID="username-rules">
            {copy.rules}
          </Text>
        )}
        {claimError ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert" testID="username-claim-error">
            {claimError}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}

function statusLine(check: UsernameCheck, name: string): { tone: 'ok' | 'bad' | 'wait'; text: string } | null {
  switch (check.state) {
    case 'empty':
      return null;
    case 'invalid':
    case 'unavailable':
      return { tone: 'bad', text: copy.reasons[check.reason] };
    case 'checking':
      return { tone: 'wait', text: copy.checking };
    case 'available':
      return { tone: 'ok', text: copy.available(name) };
    case 'error':
      return { tone: 'bad', text: check.message };
  }
}
