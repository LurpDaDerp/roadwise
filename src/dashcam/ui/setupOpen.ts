// Whether a DashPal setup is on screen: Home's card never scans while one is (`detector.ts`).
let open = 0;

/** A setup screen or sheet is showing; call the returned function when it closes. */
export function markSetupOpen(): () => void {
  open += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    open -= 1;
  };
}

export const isSetupOpen = (): boolean => open > 0;
