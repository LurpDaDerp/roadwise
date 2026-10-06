// The setup screen's live preview, through the host (the one place that references the native module's files).
// Native shows the camera in it only during the parked setup (policy `setupMode` + `previewAllowed`); the view
// is blank at every other time, so mounting it elsewhere shows nothing.
export { previewView } from '../../../../modules/dms-vision/src/preview';
