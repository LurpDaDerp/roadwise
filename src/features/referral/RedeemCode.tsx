import { normaliseReferralCode, REFERRAL_CODE_PATTERN } from '@scoring';
import { useState } from 'react';
import { TextInput, useWindowDimensions, View } from 'react-native';

import { Button, fontFamilies, Text, useTheme } from '@/ui';

import { ReferralError, type ReferralErrorCode } from './api';
import { referralCopy as copy } from './copy';
import { useRedeemReferralCode, type ReferralDeps } from './useReferrals';

/** What the field holds: upper-cased, spaces and hyphens gone, at most the code's 8 characters. */
export function cleanCodeInput(text: string): string {
  return normaliseReferralCode(text).slice(0, 8);
}

/** The line a failed attempt shows. */
export function redeemErrorLine(error: unknown): string {
  const code: ReferralErrorCode = error instanceof ReferralError ? error.code : 'unknown';
  return copy.error[code];
}

/**
 * "Got a code from a friend?": an 8-character field and *Use code*. The code is cleaned as it is
 * typed (upper case, no spaces or hyphens, so a pasted "abcd-2345" works) and checked against the
 * pattern before anything is sent, so a typo never spends one of the day's attempts. Every server
 * refusal is worded without saying whether the code exists (`copy.error`).
 *
 * Nothing is sent except on the tap. `onSaved` runs once the server has saved it.
 */
export function RedeemCode({
  deps = {},
  onSaved,
  ownCode = null,
  testID = 'redeem-code',
}: {
  deps?: Pick<ReferralDeps, 'api'>;
  onSaved: () => void;
  /** The caller's own code, when known: typing it is refused here, spending no attempt (n1). */
  ownCode?: string | null;
  testID?: string;
}) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const redeem = useRedeemReferralCode(deps);
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (redeem.isPending) return;
    if (!REFERRAL_CODE_PATTERN.test(value)) {
      setError(copy.redeem.badPattern);
      return;
    }
    if (ownCode !== null && value === ownCode) {
      setError(copy.error.own_code);
      return;
    }
    setError(null);
    try {
      await redeem.mutateAsync(value);
      onSaved();
    } catch (e) {
      setError(redeemErrorLine(e));
    }
  };

  return (
    <View style={{ gap: th.space.sm }} testID={testID}>
      <Text variant="footnote" tone="muted" importantForAccessibility="no" accessibilityElementsHidden>
        {`${copy.redeem.label} · ${copy.redeem.hint}`}
      </Text>
      <TextInput
        testID="redeem-input"
        accessibilityLabel={copy.redeem.label}
        accessibilityHint={copy.redeem.hint}
        value={value}
        onChangeText={(text) => {
          setValue(cleanCodeInput(text));
          if (error) setError(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => void submit()}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        importantForAutofill="no"
        keyboardType="default"
        returnKeyType="done"
        selectionColor={th.colors.accent}
        // Dynamic Type applied by hand, as `Text` does, so the field grows instead of clipping.
        allowFontScaling={false}
        style={{
          minHeight: 52 * scale,
          borderWidth: 1.5,
          borderColor: error ? th.colors.danger : focused ? th.colors.accent : th.colors.borderStrong,
          borderRadius: th.radius.md,
          paddingHorizontal: th.space.md,
          backgroundColor: th.colors.surface,
          color: th.colors.text,
          fontFamily: fontFamilies.numeralsBold,
          fontSize: 22 * scale,
          letterSpacing: 2,
        }}
      />
      {error ? (
        <Text
          testID="redeem-error"
          variant="callout"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label={copy.redeem.submit}
        variant="secondary"
        onPress={() => void submit()}
        loading={redeem.isPending}
        disabled={value.length === 0}
        accessibilityHint={copy.redeem.submitHint}
        testID="redeem-submit"
      />
    </View>
  );
}
