// Event routing to JS with the README's buffering rule (§3 "Buffering").
//
// Two hubs: `shared` for the DriveSense module's events and `detect` for the DriveDetect module's
// (`detectState`, `driveStarted`, `driveEnded`). Everything is emitted on the main queue. An event
// nobody listens for is buffered (at most EVENT_BUFFER_MAX per hub; when full the oldest `row` goes
// first, else the oldest event) and delivered in order when the first listener for it attaches. A
// dropped row is still in the drive's journal, where the host's seq check finds it. The hubs outlive
// module instances: the detector and the capture live for the process.
import Foundation

/// Where events go once a module exists (`DriveSenseModule`, `DriveDetectModule`).
protocol DriveSenseEventSink: AnyObject {
  func deliver(_ event: String, _ body: [String: Any])
}

final class EventHub {
  static let shared = EventHub()
  static let detect = EventHub()

  /// Same number as `EVENT_BUFFER_MAX` in `src/fake.ts`.
  static let EVENT_BUFFER_MAX: Int = 300

  /// Main queue only.
  private weak var sink: DriveSenseEventSink?
  private var listening = Set<String>()
  private var buffer: [(event: String, body: [String: Any])] = []

  private init() {}

  /// A new module instance: the listeners of the old one are gone.
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
      self.listening.removeAll()
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
    }
  }

  /// The last JS listener for `event` went away (Expo `OnStopObserving`).
  func stopObserving(_ event: String) {
    DispatchQueue.main.async {
      self.listening.remove(event)
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

  /// An event that only matters now (`speed`): delivered while a JS listener for it is attached,
  /// else dropped. Never buffered, so nothing stale piles up while JS is away.
  func emitLive(_ event: String, _ body: [String: Any]) {
    onMain {
      guard self.listening.contains(event), let sink = self.sink else { return }
      sink.deliver(event, body)
    }
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }
}
