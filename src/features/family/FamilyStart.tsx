import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Text, useTheme } from '@/ui';

import { FAMILY_CODE_PATTERN, normaliseFamilyCode } from './api';
import { familyCopy as copy } from './copy';
import { errorText, FamilyTextField } from './parts';
import { useFamilyActions, type FamilyDeps } from './useFamily';

/**
 * Join a family with its code, or start one. The Family tab shows it when there is no family, and
 * the onboarding step (A11) shows it with *Not now*. Join comes first: most people arrive with a
 * code someone gave them.
 */
export function FamilyStart({ deps = {}, onDone }: { deps?: FamilyDeps; onDone?: () => void }) {
  const th = useTheme();
  const actions = useFamilyActions(deps);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const busy = actions.join.isPending || actions.create.isPending;
  const codeReady = FAMILY_CODE_PATTERN.test(normaliseFamilyCode(code));

  const join = () => {
    setJoinError(null);
    actions.join.mutate(code, {
      onSuccess: () => onDone?.(),
      onError: (error) => setJoinError(errorText(error)),
    });
  };
  const create = () => {
    setCreateError(null);
    actions.create.mutate(name.trim(), {
      onSuccess: () => onDone?.(),
      onError: (error) => setCreateError(errorText(error)),
    });
  };

  return (
    <View style={{ gap: th.space.lg }} testID="family-start">
      <Card>
        <View style={{ gap: th.space.md }}>
          <Text variant="headline" accessibilityRole="header">
            {copy.start.joinTitle}
          </Text>
          <FamilyTextField
            testID="family-join-code"
            label={copy.start.codeLabel}
            placeholder={copy.start.codePlaceholder}
            value={code}
            onChangeText={(t) => {
              setCode(t);
              setJoinError(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={12}
            returnKeyType="go"
            onSubmitEditing={() => codeReady && !busy && join()}
            error={joinError}
          />
          <Button
            label={copy.start.join}
            onPress={join}
            disabled={!codeReady || busy}
            loading={actions.join.isPending}
            testID="family-join"
          />
        </View>
      </Card>
      <Card>
        <View style={{ gap: th.space.md }}>
          <Text variant="headline" accessibilityRole="header">
            {copy.start.createTitle}
          </Text>
          <FamilyTextField
            testID="family-create-name"
            label={copy.start.nameLabel}
            placeholder={copy.start.namePlaceholder}
            value={name}
            onChangeText={(t) => {
              setName(t);
              setCreateError(null);
            }}
            autoCapitalize="words"
            maxLength={40}
            returnKeyType="done"
            error={createError}
          />
          <Button
            label={copy.start.create}
            variant="secondary"
            onPress={create}
            disabled={name.trim() === '' || busy}
            loading={actions.create.isPending}
            testID="family-create"
          />
        </View>
      </Card>
      <Text variant="footnote" tone="muted">
        {copy.start.privacy}
      </Text>
    </View>
  );
}
