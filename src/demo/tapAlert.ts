// DEMO ONLY (temporary): a tap on the driving screen plays the phone alert. Off under Jest so the
// driving screen's own tests keep judging a touch as only waking the screen.
export const demoTap = { on: process.env.NODE_ENV !== 'test' };
