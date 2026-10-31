// Settings › Driving › Your car (iPhone only, beside the Automatic drives switch): the paired cars'
// names or "Not paired"; one tap to the pairing screen. Nothing on Android or a native build
// without the car link.
import { useRouter } from 'expo-router';

import { LinkRow } from '@/features/settings/parts';

import { carCopy } from './copy';
import { carRowLine } from './model';
import { CAR_HREF } from './PairCarCard';
import { useCarLink } from './useCarLink';

export function CarSettingRow() {
  const router = useRouter();
  const { view } = useCarLink();
  if (view.status === 'unsupported') return null;
  return (
    <LinkRow
      icon="car-sport-outline"
      title={carCopy.row.title}
      subtitle={view.status === 'ready' ? carRowLine(view.state) : undefined}
      onPress={() => router.push(CAR_HREF)}
      testID="settings-car"
    />
  );
}
