import { useEffect, useRef, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';

import { Button, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { emergencyCopy } from './copy';
import { CONTACT_NAME_MAX, contactProblem, newContactId, type ContactProblem, type EmergencyContact } from './model';

const copy = emergencyCopy.sheet;
/** Room for a number typed with spaces, dashes and brackets ("+1 (555) 123-4567 "). */
const PHONE_INPUT_MAX = 24;

/** What the sheet edits: a saved contact, or a new one (`contact` null). */
export interface ContactTarget {
  contact: EmergencyContact | null;
}

/**
 * One contact's sheet: Name and Phone number, Save, and Remove (after a check) for a saved one.
 * What is wrong shows under the fields, and nothing is saved until it is right.
 */
export function ContactSheet({
  target,
  onClose,
  onSave,
  onRemove,
}: {
  target: ContactTarget | null;
  onClose: () => void;
  onSave: (contact: EmergencyContact) => Promise<boolean>;
  onRemove: (contact: EmergencyContact) => Promise<boolean>;
}) {
  const title = target ? (target.contact?.name ?? copy.newTitle) : '';
  return (
    <Sheet visible={target !== null} onClose={onClose} title={title} scroll testID="contact-sheet">
      {target ? <ContactEditor key={target.contact?.id ?? 'new'} contact={target.contact} onClose={onClose} onSave={onSave} onRemove={onRemove} /> : null}
    </Sheet>
  );
}

function ContactEditor({
  contact,
  onClose,
  onSave,
  onRemove,
}: {
  contact: EmergencyContact | null;
  onClose: () => void;
  onSave: (contact: EmergencyContact) => Promise<boolean>;
  onRemove: (contact: EmergencyContact) => Promise<boolean>;
}) {
  const th = useTheme();
  const scale = useFontScale();
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [problem, setProblem] = useState<ContactProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // Live while open: a save that lands after the sheet closed changes nothing here.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const save = async () => {
    const next: EmergencyContact = { id: contact?.id ?? newContactId(), name: name.trim(), phone };
    const p = contactProblem(next);
    if (p) {
      setProblem(p);
      return;
    }
    setBusy(true);
    setSaveError(false);
    const ok = await onSave(next);
    if (!live.current) return;
    setBusy(false);
    if (ok) onClose();
    else setSaveError(true);
  };

  const remove = () => {
    if (!contact) return;
    Alert.alert(copy.removeTitle(contact.name), copy.removeBody, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.remove,
        style: 'destructive',
        onPress: () => {
          void onRemove(contact).then((ok) => {
            if (!live.current) return;
            if (ok) onClose();
            else setSaveError(true);
          });
        },
      },
    ]);
  };

  const inputStyle = {
    minHeight: 48 * scale,
    borderWidth: 1.5,
    borderColor: th.colors.borderStrong,
    borderRadius: th.radius.md,
    paddingHorizontal: th.space.md,
    backgroundColor: th.colors.surface,
    color: th.colors.text,
    fontSize: 17 * scale,
  } as const;

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }} testID="contact-editor">
      <View style={{ gap: th.space.sm }}>
        <Text variant="headline">{copy.name}</Text>
        <TextInput
          testID="contact-name"
          accessibilityLabel={copy.name}
          value={name}
          onChangeText={(v) => {
            setProblem(null);
            setName(v);
          }}
          placeholder={copy.namePlaceholder}
          placeholderTextColor={th.colors.textSubtle}
          maxLength={CONTACT_NAME_MAX}
          autoCapitalize="words"
          autoCorrect={false}
          autoFocus={contact === null}
          returnKeyType="next"
          allowFontScaling={false}
          style={inputStyle}
        />
      </View>
      <View style={{ gap: th.space.sm }}>
        <Text variant="headline">{copy.phone}</Text>
        <TextInput
          testID="contact-phone"
          accessibilityLabel={copy.phone}
          value={phone}
          onChangeText={(v) => {
            setProblem(null);
            setPhone(v);
          }}
          placeholder={copy.phonePlaceholder}
          placeholderTextColor={th.colors.textSubtle}
          maxLength={PHONE_INPUT_MAX}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          autoCorrect={false}
          allowFontScaling={false}
          style={inputStyle}
        />
      </View>

      {problem ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" testID="contact-problem">
          {copy.problems[problem]}
        </Text>
      ) : null}
      {saveError ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" testID="contact-save-error">
          {emergencyCopy.saveError}
        </Text>
      ) : null}

      <Button label={copy.save} onPress={() => void save()} loading={busy} testID="contact-save" />
      {contact ? <Button label={copy.remove} variant="destructive" size="md" onPress={remove} testID="contact-remove" /> : null}
    </View>
  );
}
