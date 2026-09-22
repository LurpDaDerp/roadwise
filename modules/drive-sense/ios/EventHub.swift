// Event routing to JS with the README's buffering rule (§3 "Buffering").
//
// Everything is emitted on the main queue. An event nobody listens for is buffered (at most
// EVENT_BUFFER_MAX across all events; when full the oldest `row` goes first, else the oldest
// event) and delivered in order when the first listener for it attaches — which is how the `wake`
// that relaunched the app reaches JS after the bundle loads. The hub outlives module instances:
// the capture controller and the app-delegate subscriber exist before the module does.
import Foundation

/// Where events go once a module exists (the `DriveSenseModule`).
protocol DriveSenseEventSink: AnyObject {
  func deliver(_ event: String, _ body: [String: Any])
}

final class EventHub {
  static let shared = EventHub()

  /// Same number as `EVENT_BUFFER_MAX` in `src/fake.ts`.
  static let EVENT_BUFFER_MAX: Int = 300

  /// Main queue only.
  private weak var sink: DriveSenseEventSink?
  private var listening = Set<String>()
  private var buffer: [(event: String, body: [String: Any])] = []
  /// Called on main when the set of events with a JS listener changes (the watchdog reads `row`).
  var onListeningChanged: ((_ event: String, _ listening: Bool) -> Void)?

  private init() {}

  func attach(_ sink: DriveSenseEventSink) {
    onMain {
      self.sink = sink
      self.listening.removeAll()
    }
  }

  func detach(_ sink: DriveSenseEventSink) {
    onMain {
      guard self.sink === sink else { return }
      self.sink = nil
      let had = self.listening
      self.listening.removeAll()
      for e in had { self.onListeningChanged?(e, false) }
    }
  }

  func isListening(_ event: String) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    return listening.contains(event)
  }

  /// The first JS listener for `event` attached (Expo `OnStartObserving`). The buffered events
  /// for it are delivered first, in order, then live delivery begins — all on main, so nothing
  /// emitted meanwhile can overtake them.
  func startObserving(_ event: String) {
    DispatchQueue.main.async {
      guard let sink = self.sink else { return }
      var keep: [(event: String, body: [String: Any])] = []
      var pending: [[String: Any]] = []
      for b in self.buffer {
        if b.event == event { pending.append(b.body) } else { keep.append(b) }
      }
      self.buffer = keep
      for body in pending { sink.deliver(event, body) }
      self.listening.insert(event)
      self.onListeningChanged?(event, true)
    }
  }

  /// The last JS listener for `event` went away (Expo `OnStopObserving`).
  func stopObserving(_ event: String) {
    DispatchQueue.main.async {
      guard self.listening.remove(event) != nil else { return }
      self.onListeningChanged?(event, false)
    }
  }

  /// Emit on main: delivered now when a listener is attached, else buffered.
  func emit(_ event: String, _ body: [String: Any]) {
    onMain {
      if self.listening.contains(event), let sink = self.sink {
        sink.deliver(event, body)
        return
      }
      self.buffer.append((event, body))
      if self.buffer.count > EventHub.EVENT_BUFFER_MAX {
        let oldestRow = self.buffer.firstIndex { $0.event == "row" }
        self.buffer.remove(at: oldestRow ?? 0)
      }
    }
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }
}
