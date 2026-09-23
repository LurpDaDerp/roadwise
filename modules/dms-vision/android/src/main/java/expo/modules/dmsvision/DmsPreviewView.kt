// The C2 setup preview (product C2): a CameraX PreviewView that shows the running camera ONLY while
// the latest policy has setupMode AND previewAllowed. Otherwise no Preview use case is bound at all.
// Nothing is captured, stored or sent: a preview only draws to the screen. The HUD never mounts
// this view (product §13.2).

package expo.modules.dmsvision

import android.content.Context
import android.view.ViewGroup
import androidx.camera.core.Preview
import androidx.camera.view.PreviewView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

class DmsPreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val previewView = PreviewView(context).also {
    it.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    it.scaleType = PreviewView.ScaleType.FILL_CENTER
    it.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  init {
    addView(previewView)
    DmsPreviewRegistry.add(this)
  }
}

/**
 * The mounted previews (held weakly) and the Preview use case the controller has bound, if any.
 * Main thread only.
 */
object DmsPreviewRegistry {
  private val views = ArrayList<WeakReference<DmsPreviewView>>()
  private var preview: Preview? = null

  fun add(v: DmsPreviewView) {
    views.removeAll { it.get() == null }
    views.add(WeakReference(v))
    preview?.setSurfaceProvider(v.previewView.surfaceProvider)
  }

  /** The newest mounted view draws the preview; null detaches. */
  fun show(p: Preview?) {
    preview = p
    views.removeAll { it.get() == null }
    val newest = views.lastOrNull()?.get() ?: return
    p?.setSurfaceProvider(newest.previewView.surfaceProvider)
  }
}
