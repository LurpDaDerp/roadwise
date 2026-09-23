// Resolves a file shipped in the module's `DmsVision` resource bundle. CocoaPods places a
// resource_bundles bundle inside the pod's framework (framework linkage) or the app bundle (static
// libraries), so both are searched, then the plain main bundle.

import Foundation

enum DmsBundle {
  private static let bundleName = "DmsVision"

  static func path(_ name: String, _ ext: String) -> String? {
    var candidates: [Bundle] = []
    let own = Bundle(for: DmsBundleToken.self)
    for host in [own, Bundle.main] {
      if let url = host.url(forResource: bundleName, withExtension: "bundle"), let bundle = Bundle(url: url) {
        candidates.append(bundle)
      }
    }
    candidates.append(own)
    candidates.append(Bundle.main)
    for bundle in candidates {
      if let p = bundle.path(forResource: name, ofType: ext), FileManager.default.fileExists(atPath: p) { return p }
    }
    return nil
  }
}

private final class DmsBundleToken {}
