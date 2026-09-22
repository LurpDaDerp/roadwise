import { useRef, useState } from 'react';
import { TextInput, useWindowDimensions, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { formatBirthDate, onboardingCopy } from '../copy';

const copy = onboardingCopy.profile;

/** What the driver has typed, digit by digit. Nothing is filled in for them: no default year. */
export interface BirthDateParts {
  month: string;
  day: string;
  year: string;
}

export const EMPTY_BIRTH_DATE: BirthDateParts = { month: '', day: '', year: '' };

/** 0001's `set_birth_date` bound: nothing older than this many years is accepted. */
export const MAX_AGE_YEARS = 120;

export type BirthDateCheck =
  | { ok: true; iso: string }
  | { ok: false; reason: 'incomplete' | 'invalid' | 'future' | 'too-old' };

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The local calendar date of `now` as `YYYY-MM-DD` — the day the driver is living in. */
export function localIsoDate(now: Date): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

/**
 * The typed parts as a real calendar date, or why not. `incomplete` until every part has its full
 * number of digits (the field says nothing while the driver is still typing); `invalid` for a
 * month or day that does not exist (13, 00, 31 April, 29 February in a common year); `future` for
 * a day after today on the phone's calendar; `too-old` past the server's 120-year bound. Plain
 * ISO strings compare in calendar order, so no time zone is involved.
 */
export function checkBirthDate(parts: BirthDateParts, today: Date = new Date()): BirthDateCheck {
  const digits = /^\d+$/;
  if (
    parts.month.length !== 2 ||
    parts.day.length !== 2 ||
    parts.year.length !== 4 ||
    ![parts.month, parts.day, parts.year].every((p) => digits.test(p))
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  const month = Number(parts.month);
  const day = Number(parts.day);
  const year = Number(parts.year);
  if (month < 1 || month > 12 || day < 1) return { ok: false, reason: 'invalid' };
  // Day 0 of the next month is the last day of this one, leap years included.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return { ok: false, reason: 'invalid' };

  const iso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const todayIso = localIsoDate(today);
  if (iso > todayIso) return { ok: false, reason: 'future' };
  const oldest = `${pad(today.getFullYear() - MAX_AGE_YEARS, 4)}${todayIso.slice(4)}`;
  if (iso < oldest) return { ok: false, reason: 'too-old' };
  return { ok: true, iso };
}

/** The line under the field for a finished entry that is not a date; nothing while incomplete. */
export function birthDateError(check: BirthDateCheck): string | null {
  if (check.ok) return null;
  switch (check.reason) {
    case 'invalid':
      return copy.dateInvalid;
    case 'future':
      return copy.dateFuture;
    case 'too-old':
      return copy.dateTooOld;
    default:
      return null;
  }
}

const SEGMENTS = [
  { key: 'month', label: copy.month, placeholder: copy.monthPlaceholder, length: 2, width: 3 },
  { key: 'day', label: copy.day, placeholder: copy.dayPlaceholder, length: 2, width: 3 },
  { key: 'year', label: copy.year, placeholder: copy.yearPlaceholder, length: 4, width: 5 },
] as const;

/**
 * A4's birth date, typed: MM / DD / YYYY, three number fields in the US order the product spec
 * gives. It is operable by typing alone (A4 a11y) — each field moves to the next once it has its
 * digits, and a screen reader hears "Birth date, Month" and so on. Nothing is preselected and no
 * age is mentioned: the field does not hint at what answer gets what.
 *
 * `fixed` shows a date already on the account, read-only: the server keeps the first answer.
 */
export function BirthDateField({
  value,
  onChange,
  error,
  fixed,
  editable = true,
}: {
  value: BirthDateParts;
  onChange: (next: BirthDateParts) => void;
  /** Shown under the field, announced politely. */
  error?: string | null;
  /** A birth date already saved (`YYYY-MM-DD`): printed, not editable. */
  fixed?: string | null;
  editable?: boolean;
}) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const refs = {
    month: useRef<TextInput>(null),
    day: useRef<TextInput>(null),
    year: useRef<TextInput>(null),
  };
  const [focused, setFocused] = useState<keyof BirthDateParts | null>(null);

  if (fixed) {
    return (
      <View style={{ gap: th.space.xs }} testID="birth-date-fixed">
        <FieldLabel>{copy.birthDateLabel}</FieldLabel>
        <Text variant="title2">
          {formatBirthDate(fixed)}
        </Text>
        <Text variant="footnote" tone="muted">
          {copy.birthDateFixed}
        </Text>
      </View>
    );
  }

  const set = (key: keyof BirthDateParts, length: number, next?: keyof BirthDateParts) =>
    (text: string) => {
      const digits = text.replace(/\D/g, '').slice(0, length);
      onChange({ ...value, [key]: digits });
      if (digits.length === length && next) refs[next].current?.focus();
    };

  return (
    <View style={{ gap: th.space.xs }}>
      <FieldLabel>{copy.birthDateLabel}</FieldLabel>
      <View
        accessibilityLabel={copy.birthDateLabel}
        style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}
      >
        {SEGMENTS.map((seg, i) => {
          const next = SEGMENTS[i + 1]?.key;
          return (
            <View key={seg.key} style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
              {i > 0 ? (
                <Text variant="title3" tone="subtle" importantForAccessibility="no">
                  /
                </Text>
              ) : null}
              <TextInput
                ref={refs[seg.key]}
                testID={`birth-date-${seg.key}`}
                accessibilityLabel={`${copy.birthDateLabel}, ${seg.label}`}
                value={value[seg.key]}
                onChangeText={set(seg.key, seg.length, next)}
                onFocus={() => setFocused(seg.key)}
                onBlur={() => setFocused(null)}
                editable={editable}
                placeholder={seg.placeholder}
                placeholderTextColor={th.colors.textSubtle}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={seg.length}
                returnKeyType={next ? 'next' : 'done'}
                onSubmitEditing={next ? () => refs[next].current?.focus() : undefined}
                selectionColor={th.colors.accent}
                cursorColor={th.colors.accent}
                // Dynamic Type by hand, as `Text` does it, so the digits grow instead of clipping.
                allowFontScaling={false}
                style={{
                  minHeight: 48 * scale,
                  minWidth: seg.width * 16 * scale,
                  paddingHorizontal: th.space.md,
                  borderWidth: 1.5,
                  borderRadius: th.radius.md,
                  borderColor: error
                    ? th.colors.danger
                    : focused === seg.key
                      ? th.colors.accent
                      : th.colors.borderStrong,
                  backgroundColor: th.colors.surface,
                  color: th.colors.text,
                  fontFamily: th.type.display.fontFamily,
                  fontSize: 20 * scale,
                  fontVariant: ['tabular-nums'],
                  textAlign: 'center',
                  opacity: editable ? 1 : 0.6,
                }}
              />
            </View>
          );
        })}
      </View>
      {error ? (
        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** The licence's field label: small caps over the value (the StepFrame caption's tracking). */
export function FieldLabel({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      tone="muted"
      style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}
    >
      {children}
    </Text>
  );
}
