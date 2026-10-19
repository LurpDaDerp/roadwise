import { ProfileScreen } from '@/features/profile/ProfileScreen';
import { SkyScrollScope } from '@/ui';

/** The Profile tab: public card, achievements, friends, heat map, settings and account. */
export default function ProfileRoute() {
  return (
    <SkyScrollScope name="profile">
      <ProfileScreen />
    </SkyScrollScope>
  );
}
