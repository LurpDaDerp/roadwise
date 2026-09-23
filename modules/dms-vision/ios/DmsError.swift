// Errors the module rejects with; `code` is a contract code (src/types.ts DMS_VISION_ERROR_CODES).
// Foundation only.

import Foundation

enum DmsError: Error {
  case badArgs(String)
  case permission(String)
  case notForeground(String)
  case camera(String)
  case model(String)
  case state(String)

  var code: String {
    switch self {
    case .badArgs: return "E_BAD_ARGS"
    case .permission: return "E_PERMISSION"
    case .notForeground: return "E_NOT_FOREGROUND"
    case .camera: return "E_CAMERA"
    case .model: return "E_MODEL"
    case .state: return "E_STATE"
    }
  }

  var message: String {
    switch self {
    case .badArgs(let m), .permission(let m), .notForeground(let m), .camera(let m), .model(let m), .state(let m):
      return m
    }
  }
}
