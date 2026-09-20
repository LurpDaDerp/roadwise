import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { DISPUTE_REASONS, type DisputeReason } from '@/data/db';
import { Banner, Button, Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { ICON, TIGHT, TOUCH } from './layout';
import { MAX_NOTE, type DisputeInput } from './tripActions';

/** The posted limit a driver may state, in mph — the bounds the server validates against. */
export const MIN_STATED_LIMIT = 5;
export const MAX_STATED_LIMIT = 100;

/** A stated limit outside the server's bounds is dropped rather than sent and refused. */
export function parseStatedLimit(text: string): number | undefined {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(value)) return undefined;
  if (value < MIN_STATED_LIMIT || value > MAX_STATED_LIMIT) return undefined;
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
  value,
  onChangeText,
  placeholder,
  numeric,
  multiline,
  testID,
}: {
  label: string;
  hint?: string;
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
          borderColor: th.colors.borderStrong,
          borderRadius: th.radius.sm,
          paddingHorizontal: th.space.md,
          paddingVertical: th.space.sm,
          color: th.colors.text,
          backgroundColor: th.colors.surface,
          fontSize: th.type.body.fontSize,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {hint ? (
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
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [limit, setLimit] = useState('');
  const [note, setNote] = useState('');

  const notDriver = reason === 'not_driver';
  const submit = () => {
    if (reason === null) return;
    if (notDriver) {
      onNotDriver();
      return;
    }
    const statedLimitMph = reason === 'wrong_limit' ? parseStatedLimit(limit) : undefined;
    const trimmed = note.trim();
    onSubmit({
      reason,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
      ...(statedLimitMph === undefined ? {} : { statedLimitMph }),
    });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.colors.scrim }}>
        <View
          style={{
            maxHeight: '88%',
            backgroundColor: th.colors.bgElevated,
            borderTopLeftRadius: th.radius.xl,
            borderTopRightRadius: th.radius.xl,
            borderTopWidth: StyleSheet.hairlineWidth,
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
                  borderWidth: 1,
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
            disabled={reason === null}
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
      </View>
    </Modal>
  );
}
