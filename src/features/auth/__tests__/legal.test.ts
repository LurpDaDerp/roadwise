import { SAFETY_DISCLAIMER, TERMS_VERSION } from '@/features/auth/legal';

test('the disclaimer line and the terms version the sign-in checkbox agrees to', () => {
  expect(SAFETY_DISCLAIMER).toBe('RoadWise is a coaching aid and may miss or misreport events');
  expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
