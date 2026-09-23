// The replay matrix, part 1 of 3 (plan Task 12, validation stage 1): the drives that must stay silent.
// Every scenario runs at 5, 10, 15 and 30 fps with both gaze sources (rev1 R-gaze), asserting exact event
// times. DMS_FULL=1 (test-only, see matrix.ts) runs 5 seeds and the 30 min attentive drive.
import { matrix } from '../__fixtures__/matrix';

matrix(['attentive highway', 'mirror checks', 'shoulder checks', 'intersection side looks at 30 km/h in turns', 'cluster checks', 'driver absent']);
