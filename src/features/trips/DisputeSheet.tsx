import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { DISPUTE_REASONS, type DisputeReason } from '@/data/db';
import { useLockout } from '@/features/drive/useLockout';
import { Banner, Button, Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { ICON, NOTICE_BORDER, TIGHT, TOUCH } from './layout';
import { MAX_NOTE, type DisputeInput } from './tripActions';

/** The posted limit a driver may state, in mph — the bounds the server validates against. */
export const MIN_STATED_LIMIT = 5;
export const MAX_STATED_LIMIT = 100;

/**
 * A stated limit, or `undefined` when the field is empty. A value outside the server's bounds
 * comes back as `out_of_range` rather than as nothing: dropping it silently would send the report
 * without the limit that makes it free, straight after telling the driver it was free.
 */
export function parseStatedLimit(text: string): number | 'out_of_range' | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) return 'out_of_range';
  if (value < MIN_STATED_LIMIT || value > MAX_STATED_LIMIT) return 'out_of_range';
  return value;
}

function Radio({
  label,
  checked,
  onPress,
  testID,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: TOUCH,
        paddingVertical: th.space.sm,
        paddingHorizontal: th.space.sm,
        marginHorizontal: -th.space.sm,
        borderRadius: th.radius.sm,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <Ionicons
        name={checked ? 'radio-button-on' : 'radio-button-off'}
        size={ICON.lg}
        color={checked ? th.colors.accent : th.colors.borderStrong}
      />
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Input({
  label,
  hint,
  error = null,
  value,
  onChangeText,
  placeholder,
  numeric,
  multiline,
  testID,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  numeric?: boolean;
  multiline?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.xs }}>
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={th.colors.textSubtle}
        keyboardType={numeric ? 'number-pad' : 'default'}
        multiline={multiline}
        maxLength={numeric ? 3 : MAX_NOTE}
        selectionColor={th.colors.accent}
        cursorColor={th.colors.accent}
        style={{
          minHeight: multiline ? TOUCH * 2 : TOUCH,
          borderWidth: 1,
          borderColor: error === null ? th.colors.borderStrong : th.colors.danger,
          borderRadius: th.radius.sm,
          paddingHorizontal: th.space.md,
          paddingVertical: th.space.sm,
          color: th.colors.text,
          backgroundColor: th.colors.surface,
          fontSize: th.type.body.fontSize,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error !== null ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite" testID="limit-error">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="subtle">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The report sheet (§7.D D3): a radio group of the six reasons, verbatim, and the two fields two
 * of them earn. A sheet rather than a page because §7.0 asks for one — "sheets over pages for
 * short tasks (dispute, pause sharing, share card) so users never lose their place" — so the
 * moment being reported stays on screen behind it.
 *
 * "I wasn't the driver" does not submit. It is not a claim about this one moment; it is a claim
 * about the whole drive, and §7.D D3 routes it to D5, where changing the role re-scores every
 * event at once. The sheet says so before it sends anyone anywhere.
 *
 * Nothing here decides whether the report will be applied. The allowance is the server's (§9.9);
 * the driver is told the report is saved, and told again — honestly — when the answer arrives.
 */
export function DisputeSheet({
  visible,
  busy,
  failed,
  onSubmit,
  onNotDriver,
  onClose,
  testID,
}: {
  visible: boolean;
  busy: boolean;
  failed: boolean;
  onSubmit: (input: DisputeInput) => void;
  onNotDriver: () => void;
  onClose: () => void;
  testID?: string;
}) {
  const th = useTheme();
  // A native Modal sits above the lockout overlay, so it closes itself while driving (rev1: I12).
  const lockedOut = useLockout();
  const open = visible && !lockedOut;
  return (
    <Modal
      visible={open}
      transparent
      animationType={th.reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      testID={testID}
    >
      {/* Mounted only while the sheet is open, which is what makes a dismissed sheet an abandoned
          one: the answers live in this child's state and go with it. */}
      {open ? (
        <DisputeForm
          busy={busy}
          failed={failed}
          onSubmit={onSubmit}
          onNotDriver={onNotDriver}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function DisputeForm({
  busy,
  failed,
  onSubmit,
  onNotDriver,
  onClose,
}: {
  busy: boolean;
  failed: boolean;
  onSubmit: (input: DisputeInput) => void;
  onNotDriver: () => void;
  onClose: () => void;
}) {
  const th = useTheme();
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [limit, setLimit] = useState('');
  const [note, setNote] = useState('');

  const notDriver = reason === 'not_driver';
  const stated = reason === 'wrong_limit' ? parseStatedLimit(limit) : undefined;
  const badLimit = stated === 'out_of_range';

  const submit = () => {
    if (reason === null || badLimit) return;
    if (notDriver) {
      onNotDriver();
      return;
    }
    const trimmed = note.trim();
    onSubmit({
      reason,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
      ...(typeof stated === 'number' ? { statedLimitMph: stated } : {}),
    });
  };

  return (
    <>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.colors.scrim }}
      >
        <View
          style={{
            maxHeight: '88%',
            backgroundColor: th.colors.bgElevated,
            borderTopLeftRadius: th.radius.xl,
            borderTopRightRadius: th.radius.xl,
            borderTopWidth: NOTICE_BORDER,
            borderColor: th.colors.border,
            padding: th.space.lg,
            gap: th.space.md,
          }}
        >
          <View style={{ gap: TIGHT }}>
            <Text variant="title3" accessibilityRole="header">
              {copy.dispute.title}
            </Text>
            <Text variant="subhead" tone="muted">
              {copy.dispute.instruction}
            </Text>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: th.space.md, paddingBottom: th.space.sm }}
          >
            <View accessibilityRole="radiogroup" accessibilityLabel={copy.dispute.title}>
              {DISPUTE_REASONS.map((value) => (
                <Radio
                  key={value}
                  label={copy.dispute.reasons[value]}
                  checked={reason === value}
                  onPress={() => setReason(value)}
                  testID={`reason-${value}`}
                />
              ))}
            </View>

            {notDriver ? (
              <View
                testID="not-driver-note"
                style={{
                  gap: TIGHT,
                  padding: th.space.md,
                  borderRadius: th.radius.sm,
                  borderWidth: NOTICE_BORDER,
                  borderColor: th.colors.border,
                  backgroundColor: th.colors.surface,
                }}
              >
                <Text variant="subhead">{copy.dispute.notDriverTitle}</Text>
                <Text variant="footnote" tone="muted">
                  {copy.dispute.notDriverBody}
                </Text>
              </View>
            ) : null}

            {reason === 'wrong_limit' ? (
              <Input
                label={copy.dispute.limitLabel}
                hint={copy.dispute.limitHint}
                error={badLimit ? copy.dispute.limitRange(MIN_STATED_LIMIT, MAX_STATED_LIMIT) : null}
                value={limit}
                onChangeText={setLimit}
                placeholder={copy.dispute.limitPlaceholder}
                numeric
                testID="stated-limit"
              />
            ) : null}

            {reason === 'other' ? (
              <Input
                label={copy.dispute.noteLabel}
                value={note}
                onChangeText={setNote}
                placeholder={copy.dispute.notePlaceholder}
                multiline
                testID="dispute-note"
              />
            ) : null}

            {failed ? <Banner tone="danger" message={copy.dispute.failed} /> : null}
          </ScrollView>

          <Button
            label={notDriver ? copy.dispute.notDriverGo : copy.dispute.submit}
            onPress={submit}
            disabled={reason === null || badLimit}
            loading={busy}
            testID="dispute-submit"
          />
          <Button
            label={copy.dispute.cancel}
            variant="ghost"
            size="md"
            onPress={onClose}
            testID="dispute-cancel"
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
