import { HomeScreen } from '@/features/home/HomeScreen';
import { SkyScrollScope } from '@/ui';

export default function HomeRoute() {
  return (
    <SkyScrollScope name="home">
      <HomeScreen />
    </SkyScrollScope>
  );
}
