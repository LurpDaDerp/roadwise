// The C2 setup preview (product C2): an on-screen AVCaptureVideoPreviewLayer that shows the running
// session ONLY while the latest policy has setupMode AND previewAllowed. Otherwise the layer has no
// session. Nothing is captured, stored or sent: a preview layer only draws to the screen. The HUD
// never mounts this view (product §13.2).

import AVFoundation
import ExpoModulesCore
import UIKit

final class DmsPreviewView: ExpoView {
  private let previewLayer = AVCaptureVideoPreviewLayer()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    previewLayer.videoGravity = .resizeAspectFill
    layer.addSublayer(previewLayer)
    DmsPreviewRegistry.add(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
  }

  /// Main thread only.
  func attach(_ session: AVCaptureSession?) {
    if previewLayer.session !== session { previewLayer.session = session }
  }
}

/// The mounted previews (held weakly: a view that unmounts drops out by itself); the controller's
/// preview decision is fanned out on the main thread.
enum DmsPreviewRegistry {
  private static var views = NSHashTable<DmsPreviewView>.weakObjects()
  private static var current: AVCaptureSession?

  static func add(_ v: DmsPreviewView) {
    DispatchQueue.main.async {
      views.add(v)
      v.attach(current)
    }
  }

  /// nil detaches every preview.
  static func show(_ session: AVCaptureSession?) {
    DispatchQueue.main.async {
      current = session
      for v in views.allObjects { v.attach(session) }
    }
  }
}
