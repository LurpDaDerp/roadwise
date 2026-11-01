import { useState } from 'react';
import { View } from 'react-native';

import { RowIcon, Section, TopBar } from '@/features/settings/parts';
import { Button, ListRow, Screen, Text, useTheme } from '@/ui';

import { ContactSheet, type ContactTarget } from './ContactSheet';
import { emergencyCopy } from './copy';
import { formatPhone, MAX_CONTACTS } from './model';
import { useEmergencyContacts } from './useEmergencyContacts';

const copy = emergencyCopy;

/**
 * `/settings/emergency`: up to 5 people to call from the driving screen's emergency panel, each a
 * name over its number. A tap opens the contact's sheet; Add a contact opens a new one and is off
 * at the cap. Everything stays on this phone.
 */
export function EmergencyContactsScreen() {
  const th = useTheme();
  const { contacts, save, remove } = useEmergencyContacts();
  const [target, setTarget] = useState<ContactTarget | null>(null);
  const list = contacts ?? [];
  const full = list.length >= MAX_CONTACTS;

  return (
    <Screen scroll testID="emergency-screen">
      <TopBar title={copy.title} />
      <Text variant="body">{copy.intro}</Text>

      {list.length > 0 ? (
        <Section title={copy.listTitle} footer={full ? copy.max : undefined} testID="emergency-list">
          {list.map((c) => {
            const number = formatPhone(c.phone);
            return (
              <ListRow
                key={c.id}
                title={c.name}
                subtitle={number}
                leading={<RowIcon name="person-outline" />}
                accessibilityLabel={copy.rowSpoken(c.name, number)}
                accessibilityHint={copy.rowHint}
                onPress={() => setTarget({ contact: c })}
                testID={`emergency-contact-${c.id}`}
              />
            );
          })}
        </Section>
      ) : null}

      <Button
        label={copy.add}
        icon="add"
        variant="secondary"
        onPress={() => setTarget({ contact: null })}
        disabled={contacts === undefined || full}
        testID="emergency-add"
      />

      <View style={{ gap: th.space.sm }}>
        <Text variant="footnote" tone="muted" testID="emergency-always">
          {copy.always}
        </Text>
        <Text variant="footnote" tone="muted">
          {copy.confirm}
        </Text>
      </View>

      <ContactSheet target={target} onClose={() => setTarget(null)} onSave={save} onRemove={(c) => remove(c.id)} />
    </Screen>
  );
}
