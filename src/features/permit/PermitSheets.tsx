// Permit mode's sheets: one name field (the supervisor, the name on the log, one drive's
// supervisor), the hour targets, and the state list with "Use my location".
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { RowIcon } from '@/features/settings/parts';
import { Button, Card, Divider, ListRow, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { permitCopy } from './copy';
import { targetText } from './log';
import { cleanTarget, PERMIT_NAME_MAX, type PermitTargets } from './prefs';
import { STATES_BY_NAME, type PermitState } from './states';

function useInputStyle() {
  const th = useTheme();
  const scale = useFontScale();
  return {
    minHeight: 48 * scale,
    borderWidth: 1.5,
    borderColor: th.colors.borderStrong,
    borderRadius: th.radius.md,
    paddingHorizontal: th.space.md,
    backgroundColor: th.colors.surface,
    color: th.colors.text,
    fontSize: 17 * scale,
  } as const;
}

/** Whether the component is still mounted (a save that lands after the sheet closed changes nothing). */
function useLive() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}

export interface NameSheetCopy {
  sheetTitle: string;
  body: string;
  label: string;
  placeholder: string;
  save: string;
}

/** One name, typed and saved (empty clears it). */
export function NameSheet({
  visible,
  copy,
  initial,
  onSave,
  onClose,
  testID,
}: {
  visible: boolean;
  copy: NameSheetCopy;
  initial: string | null;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
  testID: string;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={copy.sheetTitle} scroll testID={testID}>
      {visible ? <NameEditor copy={copy} initial={initial} onSave={onSave} onClose={onClose} testID={testID} /> : null}
    </Sheet>
  );
}

function NameEditor({ copy, initial, onSave, onClose, testID }: { copy: NameSheetCopy; initial: string | null; onSave: (name: string) => Promise<boolean>; onClose: () => void; testID: string }) {
  const th = useTheme();
  const input = useInputStyle();
  const live = useLive();
  const [name, setName] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await onSave(name);
    if (!live.current) return;
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  };

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }}>
      <Text variant="body" tone="muted">
        {copy.body}
      </Text>
      <View style={{ gap: th.space.sm }}>
        <Text variant="headline">{copy.label}</Text>
        <TextInput
          testID={`${testID}-input`}
          accessibilityLabel={copy.label}
          value={name}
          onChangeText={setName}
          placeholder={copy.placeholder}
          placeholderTextColor={th.colors.textSubtle}
          maxLength={PERMIT_NAME_MAX}
          autoCapitalize="words"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          allowFontScaling={false}
          style={input}
        />
      </View>
      {failed ? (
        <Text variant="footnote" tone="danger" testID={`${testID}-error`}>
          {permitCopy.saveError}
        </Text>
      ) : null}
      <Button label={copy.save} onPress={() => void save()} loading={busy} testID={`${testID}-save`} />
    </View>
  );
}

/** A typed hour field as a target: blank or 0 is none; anything unreadable is refused (undefined). */
export function parseHours(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,3}(\.\d+)?$/.test(t)) return undefined;
  return cleanTarget(Number(t));
}

const fieldText = (h: number | null) => (h === null ? '' : targetText(h));

/** The total and night targets, and "Reset to {State}'s numbers" when the state has numbers of its own. */
export function TargetsSheet({
  visible,
  targets,
  state,
  onSave,
  onReset,
  onClose,
}: {
  visible: boolean;
  targets: PermitTargets;
  /** The state whose numbers a reset goes back to; null: no reset. */
  state: PermitState | null;
  onSave: (targets: PermitTargets) => Promise<boolean>;
  onReset: () => Promise<boolean>;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={permitCopy.targets.sheetTitle} scroll testID="permit-targets-sheet">
      {visible ? <TargetsEditor targets={targets} state={state} onSave={onSave} onReset={onReset} onClose={onClose} /> : null}
    </Sheet>
  );
}

function TargetsEditor({
  targets,
  state,
  onSave,
  onReset,
  onClose,
}: {
  targets: PermitTargets;
  state: PermitState | null;
  onSave: (targets: PermitTargets) => Promise<boolean>;
  onReset: () => Promise<boolean>;
  onClose: () => void;
}) {
  const th = useTheme();
  const input = useInputStyle();
  const live = useLive();
  const copy = permitCopy.targets;
  const [total, setTotal] = useState(fieldText(targets.totalH));
  const [night, setNight] = useState(fieldText(targets.nightH));
  const [failed, setFailed] = useState(false);
  const totalH = parseHours(total);
  const nightH = parseHours(night);
  const valid = totalH !== undefined && nightH !== undefined;

  const run = async (write: () => Promise<boolean>) => {
    setFailed(false);
    const ok = await write();
    if (!live.current) return;
    if (ok) onClose();
    else setFailed(true);
  };

  const field = (label: string, value: string, set: (v: string) => void, testID: string) => (
    <View style={{ gap: th.space.sm }}>
      <Text variant="headline">{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={set}
        placeholder={copy.placeholder}
        placeholderTextColor={th.colors.textSubtle}
        keyboardType="decimal-pad"
        maxLength={6}
        allowFontScaling={false}
        style={input}
      />
    </View>
  );

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }}>
      {field(copy.total, total, setTotal, 'permit-target-total')}
      {field(copy.night, night, setNight, 'permit-target-night')}
      <Text variant="footnote" tone="muted">
        {copy.hint}
      </Text>
      {failed ? (
        <Text variant="footnote" tone="danger" testID="permit-targets-error">
          {permitCopy.saveError}
        </Text>
      ) : null}
      <Button
        label={copy.save}
        disabled={!valid}
        onPress={() => {
          if (totalH === undefined || nightH === undefined) return;
          void run(() => onSave({ totalH, nightH }));
        }}
        testID="permit-targets-save"
      />
      {state !== null ? <Button label={copy.reset(state.name)} variant="ghost" onPress={() => void run(onReset)} testID="permit-targets-reset" /> : null}
    </View>
  );
}

/** "Use my location", then every state A to Z with a tick on the one in use. */
export function StateSheet({
  visible,
  selected,
  auto,
  onAuto,
  onChoose,
  onClose,
}: {
  visible: boolean;
  selected: string | null;
  auto: boolean;
  /** Detect the state again; false when nothing was found (the sheet stays open and says so). */
  onAuto: () => Promise<boolean>;
  onChoose: (code: string) => void;
  onClose: () => void;
}) {
  const th = useTheme();
  const copy = permitCopy.state;
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useLive();
  // Each opening starts clean: a "couldn't find" from last time isn't shown before anything is tried.
  const [shownFor, setShownFor] = useState(visible);
  if (shownFor !== visible) {
    setShownFor(visible);
    if (visible) setNotFound(false);
  }

  const fromLocation = async () => {
    setBusy(true);
    setNotFound(false);
    const ok = await onAuto();
    if (!live.current) return;
    setBusy(false);
    if (ok) onClose();
    else setNotFound(true);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={copy.sheetTitle} scroll testID="permit-state-sheet">
      <View style={{ gap: th.space.md, paddingBottom: th.space.lg }}>
        <Card padded={false}>
          <ListRow
            title={copy.useLocation}
            subtitle={copy.useLocationLine}
            leading={<RowIcon name="locate-outline" />}
            trailing={auto ? <Ionicons name="checkmark" size={th.size.icon} color={th.colors.accent} /> : undefined}
            accessory="none"
            onPress={busy ? undefined : () => void fromLocation()}
            testID="permit-state-auto"
          />
        </Card>
        {notFound ? (
          <Text variant="footnote" tone="muted" testID="permit-state-not-found">
            {copy.notFound}
          </Text>
        ) : null}
        <Card padded={false}>
          {STATES_BY_NAME.map((s, i) => (
            <View key={s.code}>
              {i > 0 ? <Divider inset={th.space.lg} /> : null}
              <ListRow
                title={s.name}
                trailing={!auto && s.code === selected ? <Ionicons name="checkmark" size={th.size.icon} color={th.colors.accent} /> : undefined}
                accessory="none"
                accessibilityLabel={!auto && s.code === selected ? `${s.name}, selected` : s.name}
                onPress={() => onChoose(s.code)}
                testID={`permit-state-${s.code}`}
              />
            </View>
          ))}
        </Card>
      </View>
    </Sheet>
  );
}
