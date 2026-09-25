// C3 round 1 (review-C3 m5): the controller's lifecycle, gate, retry and owner-slot tests again, with every row at
// 0 km/h (a car stopped for the whole drive). Since Task C3 a stop never pauses the camera, so the camera's life
// must not depend on speed. The tests whose subject needs a moving car are skipped here (`movingTest`).
(globalThis as { __DMS_ROW_KMH__?: number }).__DMS_ROW_KMH__ = 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the same suite, loaded after the speed is set
require('./controller.test');
