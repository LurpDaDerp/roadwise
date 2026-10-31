// Settings › Your car (iPhone): pair the car whose Bluetooth or CarPlay is connected now (up to 3,
// family cars), see the paired ones and forget any. The output connected now is offered first; with
// several connected, each can be chosen. A name that reads like headphones is warned about, and the
// driver can still go on. Nothing pairs without the tap.
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import type { CarLinkState, CarOutput } from '@drive-sense';
import { Section, TopBar } from '@/features/settings/parts';
import { Banner, Button, ListRow, Screen, Skeleton, Text, useTheme } from '@/ui';

import { carCopy } from './copy';
import { CARS_MAX, isPaired, looksLikeHeadphones, outputName, preselect } from './model';
import { useCarLink } from './useCarLink';

const copy = carCopy.screen;

/** One connected output as a choice: its name, its kind (and Paired), a tick when chosen. */
function OutputChoice({ output, paired, chosen, onPress, testID }: { output: CarOutput; paired: boolean; chosen: boolean; onPress: () => void; testID: string }) {
  const th = useTheme();
  const name = outputName(output);
  const detail = paired ? `${carCopy.kind(output.type)} · ${copy.paired}` : carCopy.kind(output.type);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      accessibilityLabel={`${name}, ${detail}`}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => ({
        minHeight: th.size.touch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        paddingHorizontal: th.space.lg,
        paddingVertical: th.space.sm,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <Ionicons name={output.type === 'carAudio' ? 'car-outline' : 'bluetooth-outline'} size={th.size.icon} color={th.colors.accent} accessible={false} />
      <View style={{ flex: 1 }}>
        <Text variant="body">{name}</Text>
        <Text variant="footnote" tone="muted">
          {detail}
        </Text>
      </View>
      {chosen ? <Ionicons name="checkmark" size={th.size.icon} color={th.colors.accent} accessible={false} /> : null}
    </Pressable>
  );
}

function CarLinkBody({ state, failed, onPair, onForget }: { state: CarLinkState; failed: boolean; onPair: (uid: string) => Promise<unknown>; onForget: (uid: string) => Promise<unknown> }) {
  const th = useTheme();
  const [chosenUid, setChosenUid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = preselect(state, chosenUid);
  const full = state.cars.length >= CARS_MAX;
  const chosenPaired = chosen !== null && isPaired(state, chosen.uid);
  const run = (work: Promise<unknown>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };

  return (
    <>
      <Section title={copy.now} testID="car-now">
        {state.current.length === 0 ? (
          <ListRow title={copy.nothing} subtitle={copy.nothingBody} testID="car-nothing" />
        ) : (
          state.current.map((o, i) => (
            <OutputChoice key={o.uid} output={o} paired={isPaired(state, o.uid)} chosen={chosen?.uid === o.uid} onPress={() => setChosenUid(o.uid)} testID={`car-output-${i}`} />
          ))
        )}
      </Section>
      {chosen !== null ? (
        <View style={{ gap: th.space.md }}>
          <Text variant="body" testID="car-ask">
            {chosenPaired ? copy.already(outputName(chosen)) : copy.ask(outputName(chosen))}
          </Text>
          {!chosenPaired && looksLikeHeadphones(chosen.name) ? <Banner tone="warning" message={copy.headphones} testID="car-headphones" /> : null}
          {!chosenPaired && full ? <Banner tone="info" message={copy.full} testID="car-full" /> : null}
          {chosenPaired ? null : <Button label={copy.use} onPress={() => run(onPair(chosen.uid))} disabled={full} loading={busy} testID="car-use" />}
        </View>
      ) : null}
      {failed ? <Banner tone="danger" message={copy.failed} testID="car-failed" /> : null}
      {state.cars.length > 0 ? (
        <Section title={copy.cars} testID="car-paired">
          {state.cars.map((c, i) => {
            const name = outputName(c);
            const now = state.current.some((o) => o.uid === c.uid);
            return (
              <ListRow
                key={c.uid}
                title={name}
                subtitle={now ? copy.connected : carCopy.kind(c.type)}
                trailing={<Button label={copy.forget} size="sm" variant="secondary" onPress={() => run(onForget(c.uid))} accessibilityHint={copy.forgetLabel(name)} testID={`car-forget-${i}`} />}
                accessibilityLabel={name}
                testID={`car-paired-${i}`}
              />
            );
          })}
        </Section>
      ) : null}
    </>
  );
}

/** `/settings/car`: Your car. */
export function CarScreen() {
  const link = useCarLink();
  const { view } = link;
  return (
    <Screen scroll testID="car-screen">
      <TopBar title={copy.title} />
      <Text variant="body" tone="muted">
        {copy.intro}
      </Text>
      {view.status === 'loading' ? <Skeleton width="100%" height={56} /> : null}
      {view.status === 'ready' ? <CarLinkBody state={view.state} failed={link.failed} onPair={link.pair} onForget={link.forget} /> : null}
      <Text variant="footnote" tone="muted" testID="car-note">
        {copy.note}
      </Text>
    </Screen>
  );
}
