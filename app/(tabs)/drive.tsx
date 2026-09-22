import { Redirect } from 'expo-router';

/**
 * The centre Drive tab owns no screen of its own: its tab button opens the pre-drive sheet
 * (`/drive/start`) over the tabs instead of switching to this route (see `_layout.tsx`). The file
 * exists because every tab needs a route; should anything ever land here (a deep link to
 * `/drive` inside the tabs), it goes Home, where the Start drive action and any drive in progress
 * are.
 */
export default function DriveTab() {
  return <Redirect href="/home" />;
}
